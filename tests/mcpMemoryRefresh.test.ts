import { expect, it, vi } from "vitest";
import { migrationFixture } from "./mcpContextMigration.fixture";
import { buildPageStoryMemory } from "../src/main/pipeline/storyMemoryBuilder";
import { buildMergedPageMemory } from "../src/main/workContextPageMemory";
import {
  inspectMcpMemoryStatus,
  prepareMcpMemoryRefresh,
} from "../src/main/application/mcpMemoryRefreshPolicy";
import { projectContextMigrationRecovery } from "../src/main/application/mcpContextMigrationRecoveryPolicy";
import {
  McpMemoryInspectSchema,
  McpMemoryRefreshPreviewSchema,
  McpMemoryRefreshApplySchema,
} from "../src/shared/mcpMemoryRefresh";
import { inspectPageMemoryEvidence } from "../src/shared/pageMemoryEvidence";
import type { McpContextReferenceSnapshot } from "../src/shared/mcpContextReferences";

const guard = () => {};
const build = (
  page: Parameters<typeof buildPageStoryMemory>[0]["page"],
  pageIndex: number,
) => buildPageStoryMemory({ page, pageIndex });
function inspect(graph: McpContextReferenceSnapshot, extra: object = {}) {
  return inspectMcpMemoryStatus(
    graph,
    McpMemoryInspectSchema.parse({ chapterId: "chapter", ...extra }),
    guard,
  );
}
function input(graph: McpContextReferenceSnapshot, extra: object = {}) {
  const status = inspect(graph);
  const row = status.items.find(
    (item) => item.chapterId === "chapter" && item.pageId === "page",
  );
  if (!row) throw new Error("Missing test page");
  return McpMemoryRefreshPreviewSchema.parse({
    chapterId: "chapter",
    referenceSnapshot: status.referenceSnapshot,
    replaceExistingSummary: true,
    pages: [
      {
        chapterId: row.chapterId,
        pageId: row.pageId,
        revision: row.revision,
        sourceFingerprint: row.sourceFingerprint,
        translationFingerprint: row.translationFingerprint,
        summary: { kind: "reviewed-page-text", text: "New page-only summary" },
      },
    ],
    ...extra,
  });
}
function refresh(graph: McpContextReferenceSnapshot) {
  const plan = prepareMcpMemoryRefresh(
    graph,
    input(graph),
    "refreshed",
    guard,
    build,
  );
  return projectContextMigrationRecovery(graph, plan.delta, "apply");
}

it("reports legacy, absent, duplicate and orphan memories without disclosing source text or guessing freshness", () => {
  const { graph } = migrationFixture();
  expect(inspect(graph).counts).toMatchObject({ unknown: 2, orphan: 2 });
  graph.chapters[0].storyMemory.pages.push(
    structuredClone(graph.chapters[0].storyMemory.pages[0]),
  );
  graph.chapters[1].storyMemory.pages = [];
  const status = inspect(graph);
  expect(status.counts).toMatchObject({ duplicate: 2, orphan: 1, missing: 1 });
  expect(JSON.stringify(status)).not.toMatch(
    /PRIVATE|sourceText|translatedText|sourceDigest|imagePath/,
  );
  expect(() =>
    prepareMcpMemoryRefresh(graph, input(graph), "now", guard, build),
  ).toThrow("Duplicate memory");
});

it("replaces only explicitly selected summaries and preserves manual visual descriptions, references and orphan rows", () => {
  const { graph } = migrationFixture();
  graph.chapters[0].storyMemory.pages[0].visualSummary =
    "Manual picture description";
  graph.chapters[0].storyMemory.pages[0].visualSummarySource = "manual";
  const before = structuredClone(graph);
  const request = input(graph);
  const plan = prepareMcpMemoryRefresh(
    graph,
    request,
    "refreshed",
    guard,
    build,
  );
  expect(graph).toEqual(before);
  expect(plan.delta.pages).toEqual([]);
  expect(plan.delta.guide).toBeUndefined();
  expect(plan.preview.items[0]).toMatchObject({
    beforeSummary: "PRIVATE story",
    afterSummary: "New page-only summary",
    changed: true,
  });
  const next = projectContextMigrationRecovery(graph, plan.delta, "apply");
  const memory = next.chapters[0].storyMemory.pages[0];
  expect(memory).toMatchObject({
    visualSummary: "Manual picture description",
    visualSummarySource: "manual",
    characterIds: ["old-character"],
    glossaryEntryIds: ["old"],
    textEvidence: { version: 1, method: "reviewed-page-text" },
  });
  expect(next.chapters[0].storyMemory.pages[1]).toEqual(
    before.chapters[0].storyMemory.pages[1],
  );
  expect(next.chapters[1]).toEqual(before.chapters[1]);
  expect(inspect(next).counts.current).toBe(1);
  expect(() =>
    prepareMcpMemoryRefresh(
      graph,
      { ...request, replaceExistingSummary: false },
      "now",
      guard,
      build,
    ),
  ).toThrow("replaceExistingSummary");
  expect(() =>
    prepareMcpMemoryRefresh(
      graph,
      { ...request, planFingerprint: "0".repeat(16) },
      "now",
      guard,
      build,
    ),
  ).toThrow("intent differs");
});

it.each(["sourceText", "translatedText"] as const)(
  "detects %s changes beyond native excerpt truncation",
  (field) => {
    const { graph } = migrationFixture();
    graph.chapters[0].chapter.pages[0].blocks[0][field] =
      "x".repeat(1000) + "old";
    const next = refresh(graph);
    const page = next.chapters[0].chapter.pages[0];
    const old = build(page, 0);
    page.blocks[0][field] = "x".repeat(1000) + "new";
    const current = build(page, 0);
    expect(current.sourceDigest).toBe(old.sourceDigest);
    expect(current.translatedDigest).toBe(old.translatedDigest);
    expect(inspect(next).counts.stale).toBe(1);
  },
);

it("invalidates edited summaries and changed catalogs or reading order without treating a timestamp as evidence", () => {
  const initial = refresh(migrationFixture().graph);
  const timestamp = structuredClone(initial);
  timestamp.chapters[0].storyMemory.pages[0].updatedAt = "later";
  expect(inspect(timestamp).counts.current).toBe(1);
  for (const change of [
    (graph: typeof initial) => {
      graph.chapters[0].storyMemory.pages[0].summary = "Unverified edit";
    },
    (graph: typeof initial) => {
      graph.styleGuide.rules.honorifics = "drop";
    },
    (graph: typeof initial) => {
      graph.chapters[0].chapter.pages[0].blockOrder = ["unknown-order-marker"];
    },
    (graph: typeof initial) => {
      graph.chapters[0].storyMemory.pages[0].pageName = "old name";
    },
  ]) {
    const graph = structuredClone(initial);
    change(graph);
    expect(inspect(graph).counts.stale).toBe(1);
  }
  const visual = structuredClone(initial);
  visual.chapters[0].storyMemory.pages[0].visualSummary =
    "independent image description";
  expect(inspect(visual).counts.current).toBe(1);
});

it("creates missing selected memory through the existing excerpt builder without reordering other rows", () => {
  const { graph } = migrationFixture();
  graph.chapters[0].storyMemory.pages.shift();
  const request = input(graph);
  request.pages[0].summary = { kind: "native-excerpt" };
  const builder = vi.fn(build);
  const plan = prepareMcpMemoryRefresh(graph, request, "now", guard, builder);
  expect(builder).toHaveBeenCalledTimes(1);
  expect(plan.preview.items[0]).toMatchObject({
    previousStatus: "missing",
    method: "native-excerpt",
  });
  expect(plan.delta.memories[0].after.pages[0]).toEqual(
    graph.chapters[0].storyMemory.pages[0],
  );
  expect(plan.delta.memories[0].after.pages[1].textEvidence?.method).toBe(
    "native-excerpt",
  );
});

it("binds pagination, exact targets and input fingerprints while refusing empty text and malformed requests", () => {
  const { graph } = migrationFixture();
  const status = inspect(graph);
  expect(() => inspect(graph, { offset: 1 })).toThrow();
  expect(() =>
    inspect(graph, { offset: 1, snapshot: status.snapshot, issuesOnly: true }),
  ).toThrow("filter changed");
  expect(
    inspect(graph, { offset: 1, limit: 1, snapshot: status.snapshot }).items,
  ).toHaveLength(1);
  const request = input(graph);
  expect(
    McpMemoryRefreshApplySchema.safeParse({
      ...request,
      pages: [...request.pages, ...request.pages],
      planFingerprint: "0".repeat(16),
      requestId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
  expect(() =>
    prepareMcpMemoryRefresh(
      graph,
      {
        ...request,
        pages: [{ ...request.pages[0], revision: "page-v1:" + "0".repeat(16) }],
      },
      "now",
      guard,
      build,
    ),
  ).toThrow("complete saved-page");
  expect(() =>
    prepareMcpMemoryRefresh(
      graph,
      { ...request, pages: [{ ...request.pages[0], pageId: "orphan" }] },
      "now",
      guard,
      build,
    ),
  ).toThrow("saved page");
  graph.chapters[0].chapter.pages[0].blocks.forEach((block) => {
    block.sourceText = "";
    block.translatedText = "";
  });
  expect(() =>
    prepareMcpMemoryRefresh(graph, request, "now", guard, build),
  ).toThrow("changed before refresh");
  expect(() =>
    prepareMcpMemoryRefresh(graph, input(graph), "now", guard, build),
  ).toThrow("No saved page text");
});

it("does not let the legacy merge builder certify a retained old summary against new page text", () => {
  const graph = refresh(migrationFixture().graph);
  const page = graph.chapters[0].chapter.pages[0];
  const existing = graph.chapters[0].storyMemory.pages[0];
  page.blocks[0].sourceText = "Changed page";
  const base = {
    ...build(page, 0),
    workId: graph.workId,
    chapterId: "chapter",
  };
  const merged = buildMergedPageMemory(
    base,
    { pageId: page.id, summary: "Replacement suggestion" },
    new Map(),
    existing,
    "newer",
  );
  expect(merged.summary).toBe(existing.summary);
  expect(inspectPageMemoryEvidence(page, graph.styleGuide, merged).status).toBe(
    "unknown",
  );
});

it.each(["speakerId", "glossaryEntryIds"] as const)(
  "marks memory stale after a saved block %s change",
  (field) => {
    const next = refresh(migrationFixture().graph);
    const block = next.chapters[0].chapter.pages[0].blocks[0];
    if (field === "speakerId") block.speakerId = "keep-character";
    else block.glossaryEntryIds = ["keep"];
    expect(inspect(next).counts.stale).toBe(1);
  },
);
