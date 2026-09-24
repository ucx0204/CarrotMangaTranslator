import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import {
  inspectPageMemoryEvidence,
  pageMemorySummaryFingerprint,
} from "../../shared/pageMemoryEvidence";
import {
  McpMemoryInspectSchema,
  McpMemoryRefreshPreviewSchema,
  type McpMemoryInspect,
  type McpMemoryRefreshPreview,
} from "../../shared/mcpMemoryRefresh";
import type { McpContextReferenceSnapshot } from "../../shared/mcpContextReferences";
import {
  ContextMigrationDeltaSchema,
  type ContextMigrationDelta,
} from "../../shared/mcpContextMigrationState";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PageStoryMemory } from "../../shared/workContextTypes";
import { contextMigrationSnapshot } from "./mcpContextMigrationPolicy";
import { McpEditError } from "./mcpEditPolicy";

type Graph = McpContextReferenceSnapshot;
type Builder = (page: MangaPage, pageIndex: number) => PageStoryMemory;
type Target = McpMemoryRefreshPreview["pages"][number];

export function inspectMcpMemoryStatus(
  graph: Graph,
  input: McpMemoryInspect,
  guard: () => void,
) {
  const request = McpMemoryInspectSchema.parse(input);
  const referenceSnapshot = contextMigrationSnapshot(
    graph,
    request.chapterId,
    guard,
  ).snapshot;
  const snapshot = hashStableValue({
    referenceSnapshot,
    issuesOnly: request.issuesOnly,
  });
  if (request.snapshot && request.snapshot !== snapshot)
    throw new McpEditError(
      "revision_conflict",
      "Memory inventory or filter changed. Restart pagination.",
    );
  const all = memoryRows(graph, guard);
  const counts = {
    current: 0,
    stale: 0,
    unknown: 0,
    missing: 0,
    duplicate: 0,
    orphan: 0,
  };
  for (const row of all) counts[row.status]++;
  const selected = request.issuesOnly
    ? all.filter((row) => row.status !== "current")
    : all;
  guard();
  return {
    workId: graph.workId,
    anchorChapterId: request.chapterId,
    referenceSnapshot,
    snapshot,
    total: selected.length,
    offset: request.offset,
    limit: request.limit,
    nextOffset:
      request.offset + request.limit < selected.length
        ? request.offset + request.limit
        : null,
    counts,
    items: selected.slice(request.offset, request.offset + request.limit),
    pagesChanged: 0 as const,
    note: "Full saved-page text and explicit summary evidence only. Legacy excerpts/timestamps never certify freshness. Current means matching saved text/context, not correct OCR, a verified visual scene or good summary quality. Counts include all rows and missing saved pages; filters affect only the list. No files, images or models are changed.",
  };
}

function memoryRows(graph: Graph, guard: () => void) {
  return graph.chapters.flatMap(({ chapter, storyMemory }) => {
    const groups = new Map<
      string,
      Array<{ memory: PageStoryMemory; index: number }>
    >();
    storyMemory.pages.forEach((memory, index) => {
      const rows = groups.get(memory.pageId) ?? [];
      rows.push({ memory, index });
      groups.set(memory.pageId, rows);
    });
    const present = new Set(chapter.pages.map((page) => page.id));
    const rows = chapter.pages.flatMap((page, pageIndex) => {
      guard();
      const matches = groups.get(page.id) ?? [];
      const selected = matches.length
        ? matches
        : [{ memory: undefined, index: null }];
      return selected.map(({ memory, index }) =>
        savedMemoryRow(
          graph,
          chapter.id,
          page,
          pageIndex,
          memory,
          index,
          matches.length > 1,
        ),
      );
    });
    return [
      ...rows,
      ...storyMemory.pages.flatMap((memory, index) => {
        guard();
        return present.has(memory.pageId)
          ? []
          : [orphanMemoryRow(chapter.id, memory, index)];
      }),
    ];
  });
}

function savedMemoryRow(
  graph: Graph,
  chapterId: string,
  page: MangaPage,
  pageIndex: number,
  memory: PageStoryMemory | undefined,
  memoryIndex: number | null,
  duplicate: boolean,
) {
  const checked = inspectPageMemoryEvidence(page, graph.styleGuide, memory);
  const moved = Boolean(
    memory && (memory.pageName !== page.name || memory.pageIndex !== pageIndex),
  );
  const status = duplicate
    ? ("duplicate" as const)
    : moved && checked.status === "current"
      ? ("stale" as const)
      : checked.status;
  return {
    chapterId,
    pageId: page.id,
    pageIndex,
    memoryIndex,
    revision: createPageRevision(page),
    status,
    reasons: [
      ...checked.reasons,
      ...(duplicate ? ["duplicate_memory_rows"] : []),
      ...(moved ? ["page_name_or_index_changed"] : []),
    ],
    sourceFingerprint: checked.current.sourceFingerprint,
    translationFingerprint: checked.current.translationFingerprint,
    method: memory?.textEvidence?.method ?? null,
    visualSummary: visualStatus(memory),
  };
}

function orphanMemoryRow(
  chapterId: string,
  memory: PageStoryMemory,
  memoryIndex: number,
) {
  return {
    chapterId,
    pageId: memory.pageId,
    pageIndex: null,
    memoryIndex,
    revision: null,
    status: "orphan" as const,
    reasons: ["saved_page_missing"],
    sourceFingerprint: null,
    translationFingerprint: null,
    method: memory.textEvidence?.method ?? null,
    visualSummary: visualStatus(memory),
  };
}
function visualStatus(memory: PageStoryMemory | undefined) {
  return memory?.visualSummarySource === "manual"
    ? ("manual_preserved_not_verified" as const)
    : ("not_checked" as const);
}

/** Caller supplies the existing native excerpt builder, never a second summarization engine. */
export function prepareMcpMemoryRefresh(
  graph: Graph,
  input: McpMemoryRefreshPreview & { planFingerprint?: string },
  now: string,
  guard: () => void,
  build: Builder,
) {
  const { planFingerprint: expected, ...intent } = input;
  const request = McpMemoryRefreshPreviewSchema.parse(intent);
  const beforeSnapshot = contextMigrationSnapshot(
    graph,
    request.chapterId,
    guard,
  ).snapshot;
  if (beforeSnapshot !== request.referenceSnapshot)
    throw new McpEditError(
      "revision_conflict",
      "Saved work, memory or page changed before refresh.",
    );
  const planFingerprint = hashStableValue({
    kind: "memory-refresh",
    ...request,
  });
  if (expected && expected !== planFingerprint)
    throw new McpEditError(
      "revision_conflict",
      "Memory refresh intent differs from its preview.",
    );
  const next = structuredClone(graph);
  const items = request.pages.map((target) =>
    refreshPage(
      next,
      target,
      request.replaceExistingSummary,
      now,
      build,
      guard,
    ),
  );
  const delta: ContextMigrationDelta = { pages: [], memories: [] };
  for (const [index, chapter] of next.chapters.entries()) {
    const before = graph.chapters[index].storyMemory;
    if (hashStableValue(before) !== hashStableValue(chapter.storyMemory))
      delta.memories.push({
        chapterId: chapter.chapter.id,
        before,
        after: chapter.storyMemory,
      });
  }
  ContextMigrationDeltaSchema.parse(delta);
  return {
    delta,
    beforeSnapshot,
    afterSnapshot: contextMigrationSnapshot(next, request.chapterId, guard)
      .snapshot,
    preview: {
      workId: graph.workId,
      anchorChapterId: request.chapterId,
      referenceSnapshot: beforeSnapshot,
      planFingerprint,
      status: "preview_only" as const,
      pagesChanged: 0 as const,
      items,
      note: "Only selected text summaries and their full-text evidence are refreshed. Native excerpts are deterministic text, not AI summaries. Reviewed text must describe this saved page, not internet research. Visual summaries, other rows, references, catalog, dialogue and images are preserved. Apply separately; inspect and Undo/Redo through the durable context-migration tools.",
    },
  };
}

function refreshPage(
  graph: Graph,
  target: Target,
  replace: boolean,
  now: string,
  build: Builder,
  guard: () => void,
) {
  guard();
  const { chapter, page, pageIndex, before, evidence } = refreshTarget(
    graph,
    target,
  );
  if (before?.summary.trim() && !replace)
    throw new McpEditError(
      "invalid_edit",
      "Replacing an existing summary requires replaceExistingSummary=true; keeping it is not a refresh.",
    );
  const after = refreshedMemory(
    page,
    pageIndex,
    before,
    target,
    now,
    build,
    evidence.current,
  );
  const changed = !before || hashStableValue(before) !== hashStableValue(after);
  if (changed) {
    after.updatedAt = now;
    const index = chapter.storyMemory.pages.findIndex(
      (memory) => memory.pageId === page.id,
    );
    if (index < 0) chapter.storyMemory.pages.push(after);
    else chapter.storyMemory.pages[index] = after;
    chapter.storyMemory.updatedAt = now;
  }
  return {
    chapterId: target.chapterId,
    pageId: target.pageId,
    previousStatus: evidence.status,
    method: target.summary.kind,
    beforeSummary: before?.summary ?? null,
    afterSummary: after.summary,
    changed,
    visualSummaryPreserved: true as const,
  };
}

function refreshTarget(graph: Graph, target: Target) {
  const chapter = graph.chapters.find(
    (item) => item.chapter.id === target.chapterId,
  );
  const pageIndex =
    chapter?.chapter.pages.findIndex((page) => page.id === target.pageId) ?? -1;
  const page = chapter?.chapter.pages[pageIndex];
  if (!chapter || !page)
    throw new McpEditError(
      "not_found",
      "Memory refresh requires a saved page in the inspected work.",
    );
  const matches = chapter.storyMemory.pages.filter(
    (memory) => memory.pageId === page.id,
  );
  if (matches.length > 1)
    throw new McpEditError(
      "invalid_edit",
      "Duplicate memory rows must be resolved explicitly before refresh.",
    );
  const before = matches[0];
  const evidence = inspectPageMemoryEvidence(page, graph.styleGuide, before);
  if (
    createPageRevision(page) !== target.revision ||
    target.sourceFingerprint !== evidence.current.sourceFingerprint ||
    target.translationFingerprint !== evidence.current.translationFingerprint
  )
    throw new McpEditError(
      "revision_conflict",
      "Read the complete saved-page evidence before refreshing its summary.",
    );
  return { chapter, page, pageIndex, before, evidence };
}

function refreshedMemory(
  page: MangaPage,
  pageIndex: number,
  before: PageStoryMemory | undefined,
  target: Target,
  now: string,
  build: Builder,
  evidence: ReturnType<typeof inspectPageMemoryEvidence>["current"],
): PageStoryMemory {
  const base = build(page, pageIndex);
  if (!base.sourceDigest.trim() && !base.translatedDigest.trim())
    throw new McpEditError(
      "invalid_edit",
      "No saved page text is available. Image-only or internet facts cannot be certified as page-text memory.",
    );
  const after: PageStoryMemory = {
    ...(before ?? base),
    pageName: page.name,
    pageIndex,
    sourceDigest: base.sourceDigest,
    translatedDigest: base.translatedDigest,
    summary:
      target.summary.kind === "reviewed-page-text"
        ? target.summary.text
        : base.summary || base.translatedDigest || base.sourceDigest,
    updatedAt: before?.updatedAt ?? now,
  };
  after.textEvidence = {
    version: 1,
    method: target.summary.kind,
    ...evidence,
    summaryFingerprint: pageMemorySummaryFingerprint(after),
  };
  return after;
}
