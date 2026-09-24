import { expect, it } from "vitest";
import { migrationFixture } from "./mcpContextMigration.fixture";
import {
  prepareMcpContextMigration,
  createMcpContextMigrationDelta,
  contextMigrationSnapshot,
} from "../src/main/application/mcpContextMigrationPolicy";
import { projectContextMigrationRecovery } from "../src/main/application/mcpContextMigrationRecoveryPolicy";
import { ContextMigrationDeltaSchema } from "../src/shared/mcpContextMigrationState";

const merge = {
  kind: "merge",
  entity: "glossary",
  sourceIds: ["old"],
  targetId: "keep",
};

it("computes only catalog and reference changes and reverses their exact native state", async () => {
  const f = migrationFixture();
  for (const item of f.graph.chapters)
    item.chapter.pages[0].blocks[0].glossaryEntryIds?.push(
      "unrelated",
      "unrelated",
    );
  const before = structuredClone(f.graph);
  const prepared = prepareMcpContextMigration(
    f.graph,
    await f.input(merge),
    () => {},
  );
  const result = createMcpContextMigrationDelta(
    f.graph,
    prepared,
    "saved",
    () => {},
  );
  expect(f.graph).toEqual(before);
  expect(result.delta.pages).toHaveLength(2);
  const applied = projectContextMigrationRecovery(
    f.graph,
    result.delta,
    "apply",
  );
  expect(
    applied.chapters[0].chapter.pages[0].blocks[0].glossaryEntryIds,
  ).toEqual(["keep", "__proto__", "unrelated", "unrelated"]);
  expect(applied.chapters[0].storyMemory.pages[1]).toMatchObject({
    pageId: "orphan",
    glossaryEntryIds: ["keep"],
    summary: "PRIVATE story",
    sourceDigest: "PRIVATE source",
    updatedAt: "saved",
  });
  expect(contextMigrationSnapshot(applied, "chapter", () => {}).snapshot).toBe(
    result.afterSnapshot,
  );
  expect(
    projectContextMigrationRecovery(applied, result.delta, "undo"),
  ).toEqual(before);
  const redone = projectContextMigrationRecovery(before, result.delta, "redo");
  expect(redone).toEqual(applied);
});

it("keeps absent reference fields absent, deletes unlinked speakers and restores original provenance", async () => {
  const f = migrationFixture();
  delete f.graph.chapters[1].chapter.pages[0].blocks[0].speakerId;
  const before = structuredClone(f.graph);
  const prepared = prepareMcpContextMigration(
    f.graph,
    await f.input({
      kind: "delete",
      entity: "character",
      entryIds: ["old-character"],
      unlinkReferences: true,
    }),
    () => {},
  );
  const result = createMcpContextMigrationDelta(
    f.graph,
    prepared,
    "saved",
    () => {},
  );
  const applied = projectContextMigrationRecovery(
    f.graph,
    result.delta,
    "apply",
  );
  expect(applied.chapters[0].chapter.pages[0].blocks[0]).not.toHaveProperty(
    "speakerId",
  );
  expect(applied.chapters[1].chapter.pages[0].blocks[0]).not.toHaveProperty(
    "speakerId",
  );
  expect(applied.chapters[0].storyMemory.pages[0].characterIds).toEqual([]);
  expect(
    projectContextMigrationRecovery(applied, result.delta, "undo"),
  ).toEqual(before);
});

it("treats a matching catalog replacement as no mutation and preserves omitted optional fields", async () => {
  const f = migrationFixture();
  const entries = f.graph.styleGuide.glossary.map(
    ({
      origin: _origin,
      createdAt: _created,
      updatedAt: _updated,
      ...fields
    }) => fields,
  );
  const prepared = prepareMcpContextMigration(
    f.graph,
    await f.input({ kind: "replace-glossary", entries }),
    () => {},
  );
  const result = createMcpContextMigrationDelta(
    f.graph,
    prepared,
    "saved",
    () => {},
  );
  expect(result.delta).toEqual({ pages: [], memories: [] });
  expect(result.beforeSnapshot).toBe(result.afterSnapshot);
});

it("creates new explicit catalog entries as manual without rewriting unrelated fields", async () => {
  const f = migrationFixture();
  const before = structuredClone(f.graph);
  const entries = f.graph.styleGuide.characters.map(
    ({
      origin: _origin,
      createdAt: _created,
      updatedAt: _updated,
      ...fields
    }) => fields,
  );
  const prepared = prepareMcpContextMigration(
    f.graph,
    await f.input({
      kind: "replace-characters",
      entries: [...entries, { ...entries[0], id: "new" }],
    }),
    () => {},
  );
  const { delta } = createMcpContextMigrationDelta(
    f.graph,
    prepared,
    "saved",
    () => {},
  );
  expect(delta.guide?.after.characters[2]).toMatchObject({
    id: "new",
    origin: "manual",
    createdAt: "saved",
    updatedAt: "saved",
  });
  expect(delta.guide?.after.characters[0]).toEqual(
    before.styleGuide.characters[0],
  );
  expect(delta.pages).toEqual([]);
  expect(delta.memories).toEqual([]);
});

it("rejects changed reference fields or memory before recovery, not just a missing block", async () => {
  const f = migrationFixture();
  const prepared = prepareMcpContextMigration(
    f.graph,
    await f.input(merge),
    () => {},
  );
  const { delta } = createMcpContextMigrationDelta(
    f.graph,
    prepared,
    "saved",
    () => {},
  );
  const changed = structuredClone(f.graph);
  changed.chapters[0].chapter.pages[0].blocks[0].glossaryEntryIds = [];
  expect(() =>
    projectContextMigrationRecovery(changed, delta, "apply"),
  ).toThrow("references changed");
  const memory = structuredClone(f.graph);
  memory.chapters[1].storyMemory.pages[0].summary = "later edit";
  expect(() => projectContextMigrationRecovery(memory, delta, "apply")).toThrow(
    "memory changed",
  );
  const missing = structuredClone(f.graph);
  missing.chapters[0].chapter.pages[0].blocks = [];
  expect(() =>
    projectContextMigrationRecovery(missing, delta, "apply"),
  ).toThrow("block no longer exists");
});

it("rejects mismatched work identity and duplicate native delta targets", async () => {
  const f = migrationFixture();
  const prepared = prepareMcpContextMigration(
    f.graph,
    await f.input(merge),
    () => {},
  );
  const { delta } = createMcpContextMigrationDelta(
    f.graph,
    prepared,
    "saved",
    () => {},
  );
  expect(
    ContextMigrationDeltaSchema.safeParse({
      ...delta,
      pages: [...delta.pages, delta.pages[0]],
    }).success,
  ).toBe(false);
  if (!delta.guide) throw new Error("Missing catalog delta");
  delta.guide.after.workId = "different-work";
  expect(() =>
    projectContextMigrationRecovery(f.graph, delta, "apply"),
  ).toThrow("another work");
});
