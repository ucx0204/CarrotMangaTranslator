import { randomUUID } from "node:crypto";
import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import {
  ChapterStoryMemorySchema,
  CharacterProfileSchema,
  GlossaryEntrySchema,
  WorkStyleGuideSchema,
} from "../../shared/ipcWorkContextSchemas";
import { hashStableValue } from "../../shared/blockFingerprint";
import { createPageRevision } from "../../shared/pageRevision";
import {
  McpContextPreviewSchema,
  mcpContextRevision,
  type McpContextChange,
  type McpContextChangeSummary,
} from "../../shared/mcpContextEditing";
import { McpEditError } from "./mcpEditPolicy";

export type McpContextSnapshot = {
  workId: string;
  workTitle: string;
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  chapter: ChapterSnapshot;
};
export type McpContextPlan = {
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  changes: McpContextChangeSummary[];
  guideChanged: boolean;
  memoryChanged: boolean;
};
export type McpContextPlanOptions = {
  now: string;
  entryIds: Record<string, string>;
  origin: "manual" | "ai";
};

/** Pure partial edits. No model, file, image, translation or destructive reset. */
export function planMcpContextChanges(
  snapshot: McpContextSnapshot,
  input: {
    chapterId: string;
    revision: string;
    requestId: string;
    changes: McpContextChange[];
  },
  options: McpContextPlanOptions,
): McpContextPlan {
  const request = McpContextPreviewSchema.parse(input);
  assertContextTarget(snapshot, request.chapterId, request.revision);
  const styleGuide = structuredClone(snapshot.styleGuide);
  const storyMemory = structuredClone(snapshot.storyMemory);
  const seen = new Set<string>();
  const changeIds = new Set<string>();
  const changes = request.changes.map((change) => {
    const key = changeTargetKey(change);
    if (
      seen.has(key) ||
      changeIds.has(change.changeId) ||
      !Object.keys(change.values).length
    )
      throw new McpEditError(
        "invalid_edit",
        "Use nonempty patches and distinct change IDs and targets.",
      );
    seen.add(key);
    changeIds.add(change.changeId);
    return applyChange(
      { ...snapshot, styleGuide, storyMemory },
      change,
      options,
    );
  });
  validateTouchedMemoryReferences(changes, styleGuide, storyMemory);
  const guideChanged = changes.some(
    (item) => item.entity !== "memory" && item.changed,
  );
  const memoryChanged = changes.some(
    (item) => item.entity === "memory" && item.changed,
  );
  if (guideChanged) styleGuide.updatedAt = options.now;
  if (memoryChanged) storyMemory.updatedAt = options.now;
  WorkStyleGuideSchema.parse(styleGuide);
  ChapterStoryMemorySchema.parse(storyMemory);
  return { styleGuide, storyMemory, changes, guideChanged, memoryChanged };
}

export function assertContextTarget(
  snapshot: McpContextSnapshot,
  chapterId: string,
  revision: string,
): void {
  if (
    snapshot.chapter.id !== chapterId ||
    snapshot.chapter.workId !== snapshot.workId ||
    snapshot.styleGuide.workId !== snapshot.workId ||
    snapshot.storyMemory.workId !== snapshot.workId ||
    snapshot.storyMemory.chapterId !== chapterId
  )
    throw new McpEditError(
      "not_found",
      "Context membership does not match the requested chapter.",
    );
  if (mcpContextRevision(snapshot) !== revision)
    throw new McpEditError(
      "revision_conflict",
      "Context changed. Read it again and create a new proposal.",
    );
}

function changeTargetKey(change: McpContextChange): string {
  if (change.entity === "rules") return "rules";
  if (change.entity === "memory") return `memory:${change.pageId}`;
  return `${change.entity}:${change.entryId ?? `new:${change.changeId}`}`;
}

function applyChange(
  snapshot: McpContextSnapshot,
  change: McpContextChange,
  options: McpContextPlanOptions,
): McpContextChangeSummary {
  if (change.entity === "memory")
    return applyMemory(snapshot, change, options.now);
  if (change.entity === "rules") {
    const before = snapshot.styleGuide.rules;
    const after = { ...before, ...change.values };
    snapshot.styleGuide.rules = after;
    return describeChange(change, "rules", before, after);
  }
  return applyEntry(snapshot, change, options);
}

function applyEntry(
  snapshot: McpContextSnapshot,
  change: Extract<McpContextChange, { entity: "glossary" | "character" }>,
  options: McpContextPlanOptions,
): McpContextChangeSummary {
  const entries =
    change.entity === "glossary"
      ? snapshot.styleGuide.glossary
      : snapshot.styleGuide.characters;
  const matches = change.entryId
    ? entries.filter((entry) => entry.id === change.entryId)
    : [];
  if (change.entryId && matches.length !== 1)
    throw new McpEditError(
      "not_found",
      "A unique existing context entry is required.",
    );
  const before = matches[0];
  const id = contextEntryId(before?.id, entries, change.changeId, options);
  const defaults = newEntryDefaults(change.entity);
  const after = {
    ...(before ?? {
      ...defaults,
      id,
      enabled: true,
      origin: options.origin,
      createdAt: options.now,
      updatedAt: options.now,
    }),
    ...change.values,
  };
  const changed = !before || hashStableValue(before) !== hashStableValue(after);
  if (changed) Object.assign(after, { updatedAt: options.now });
  storeContextEntry(
    snapshot.styleGuide,
    change.entity,
    id,
    Boolean(before),
    after,
  );
  return describeChange(change, id, before ?? null, after);
}

function contextEntryId(
  existing: string | undefined,
  entries: readonly { id: string }[],
  changeId: string,
  options: McpContextPlanOptions,
): string {
  if (existing) return existing;
  // Change IDs are data, including constructor/toString/__proto__. Never read
  // an inherited value or invoke the legacy __proto__ setter as an ID cache.
  if (!Object.hasOwn(options.entryIds, changeId))
    Object.defineProperty(options.entryIds, changeId, {
      value: randomUUID(),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  const id = options.entryIds[changeId];
  if (entries.some((entry) => entry.id === id))
    throw new McpEditError(
      "invalid_edit",
      "New context entry ID is already in use.",
    );
  return id;
}

function newEntryDefaults(entity: "glossary" | "character") {
  return entity === "glossary"
    ? { target: "", category: "term" }
    : { targetName: "", sourceNames: [], speechStyle: "neutral" };
}

function storeContextEntry(
  guide: WorkStyleGuide,
  entity: "glossary" | "character",
  id: string,
  exists: boolean,
  after: Record<string, unknown>,
): void {
  if (entity === "glossary") {
    const checked = GlossaryEntrySchema.parse(after);
    guide.glossary = exists
      ? guide.glossary.map((entry) => (entry.id === id ? checked : entry))
      : [...guide.glossary, checked];
  } else {
    const checked = CharacterProfileSchema.parse(after);
    guide.characters = exists
      ? guide.characters.map((entry) => (entry.id === id ? checked : entry))
      : [...guide.characters, checked];
  }
}

function applyMemory(
  snapshot: McpContextSnapshot,
  change: Extract<McpContextChange, { entity: "memory" }>,
  now: string,
): McpContextChangeSummary {
  const pages = snapshot.chapter.pages.filter(
    (page) => page.id === change.pageId,
  );
  if (pages.length !== 1)
    throw new McpEditError(
      "not_found",
      "A unique saved page is required for memory editing.",
    );
  const page = pages[0];
  if (createPageRevision(page) !== change.pageRevision)
    throw new McpEditError(
      "revision_conflict",
      "Page changed since the memory edit was prepared.",
    );
  const matches = snapshot.storyMemory.pages.filter(
    (item) => item.pageId === page.id,
  );
  if (matches.length > 1)
    throw new McpEditError(
      "invalid_edit",
      "Duplicate page memories must be resolved in the app first.",
    );
  const before = matches[0];
  if (!before && change.values.summary === undefined)
    throw new McpEditError(
      "invalid_edit",
      "A new page memory requires an explicit summary.",
    );
  const after = {
    ...(before ?? {
      pageId: page.id,
      pageName: page.name,
      pageIndex: snapshot.chapter.pages.indexOf(page),
      sourceDigest: "",
      translatedDigest: "",
      summary: "",
      updatedAt: now,
    }),
    ...change.values,
    pageName: page.name,
    pageIndex: snapshot.chapter.pages.indexOf(page),
    ...(change.values.visualSummary !== undefined
      ? { visualSummarySource: "manual" as const }
      : {}),
  };
  if (!before || hashStableValue(before) !== hashStableValue(after))
    after.updatedAt = now;
  snapshot.storyMemory.pages = before
    ? snapshot.storyMemory.pages.map((item) =>
        item.pageId === page.id ? after : item,
      )
    : [...snapshot.storyMemory.pages, after];
  return describeChange(change, page.id, before ?? null, after);
}

function validateTouchedMemoryReferences(
  changes: McpContextChangeSummary[],
  guide: WorkStyleGuide,
  memory: ChapterStoryMemory,
): void {
  const glossary = new Set(guide.glossary.map((entry) => entry.id));
  const characters = new Set(guide.characters.map((entry) => entry.id));
  for (const change of changes.filter((item) => item.entity === "memory")) {
    const page = memory.pages.find((item) => item.pageId === change.targetId);
    if (!page) throw new McpEditError("not_found", "Edited memory is missing.");
    for (const [ids, known] of [
      [page.glossaryEntryIds ?? [], glossary],
      [page.characterIds ?? [], characters],
    ] as const) {
      if (new Set(ids).size !== ids.length || ids.some((id) => !known.has(id)))
        throw new McpEditError(
          "invalid_edit",
          "Page memory references must name distinct existing context entries.",
        );
    }
  }
}

function describeChange(
  change: McpContextChange,
  targetId: string,
  before: object | null,
  after: object,
): McpContextChangeSummary {
  return {
    changeId: change.changeId,
    entity: change.entity,
    targetId,
    changed:
      before === null || hashStableValue(before) !== hashStableValue(after),
    before: before ? JSON.parse(JSON.stringify(before)) : null,
    after: JSON.parse(JSON.stringify(after)),
  };
}
