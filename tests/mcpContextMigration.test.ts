import { expect, it, vi } from "vitest";
import { migrationFixture } from "./mcpContextMigration.fixture";
import {
  McpContextMigrationPreviewSchema,
  mcpContextMigrationOutputs,
} from "../src/shared/mcpContextMigration";
import { McpContextReferencesSchema } from "../src/shared/mcpContextReferences";

const merge = {
  kind: "merge",
  entity: "glossary",
  sourceIds: ["old"],
  targetId: "keep",
};
const keep = {
  id: "keep",
  source: "keep",
  target: "replacement",
  category: "term",
  enabled: true,
};

it("previews all affected chapter-qualified block and memory links without changing any saved content", async () => {
  const f = migrationFixture();
  const before = structuredClone(f.graph);
  const input = await f.input(merge, { section: "references" });
  const result = await f.service.preview(input, () => {});
  expect(result).toMatchObject({
    status: "preview_only",
    executable: false,
    pagesChanged: 0,
    total: 8,
    counts: {
      entriesRemoved: 1,
      entriesUpdated: 0,
      entriesAdded: 0,
      referencesRemapped: 8,
      referencesUnlinked: 0,
      pagesAffected: 2,
      memoryRowsAffected: 4,
      orphanedMemoryRowsAffected: 2,
      manualEntriesPreserved: 1,
    },
  });
  expect(result.references.every((row) => row.toId === "keep")).toBe(true);
  expect(result.references.some((row) => row.duplicate)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|imagePath|sourceDigest|translatedDigest|translatedText/,
  );
  expect(f.graph).toEqual(before);
  expect(
    mcpContextMigrationOutputs.carrot_preview_context_migration.parse(result),
  ).toEqual(result);
});

it("keeps character and glossary namespaces separate and preserves destination metadata by default", async () => {
  const f = migrationFixture();
  const result = await f.service.preview(
    await f.input({
      kind: "merge",
      entity: "character",
      sourceIds: ["old-character"],
      targetId: "keep-character",
    }),
    () => {},
  );
  expect(result.counts.referencesRemapped).toBe(6);
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({
    entity: "character",
    entryId: "old-character",
    operation: "removed",
    after: null,
  });
  expect(result.entries[0].before).not.toHaveProperty("origin");
  expect(result.entries[0].before).not.toHaveProperty("createdAt");
});

it("requires explicit unlinking before deleting referenced entries, including orphaned memories", async () => {
  const f = migrationFixture();
  const command = { kind: "delete", entity: "glossary", entryIds: ["old"] };
  await expect(
    f.service.preview(await f.input(command), () => {}),
  ).rejects.toThrow("explicit destination or unlink");
  const result = await f.service.preview(
    await f.input(
      { ...command, unlinkReferences: true },
      { section: "references" },
    ),
    () => {},
  );
  expect(result.counts).toMatchObject({
    referencesUnlinked: 8,
    referencesRemapped: 0,
    orphanedMemoryRowsAffected: 2,
  });
  expect(result.references.every((row) => row.toId === null)).toBe(true);
});

it("protects both manual and legacy provenance unless the exact command explicitly opts out", async () => {
  const f = migrationFixture();
  const command = { kind: "delete", entity: "glossary", entryIds: ["manual"] };
  await expect(
    f.service.preview(await f.input(command), () => {}),
  ).rejects.toThrow("protected");
  delete f.graph.styleGuide.glossary[2].origin;
  await expect(
    f.service.preview(await f.input(command), () => {}),
  ).rejects.toThrow("protected");
  const result = await f.service.preview(
    await f.input(command, { preserveManual: false }),
    () => {},
  );
  expect(result.counts).toMatchObject({
    entriesRemoved: 1,
    referencesUnlinked: 0,
  });
});

it("retains omitted protected entries during replacement and requires mappings for removed referenced IDs", async () => {
  const f = migrationFixture();
  const command = {
    kind: "replace-glossary",
    entries: [keep],
    mappings: [
      { fromId: "old", toId: "keep" },
      { fromId: "__proto__", toId: "keep" },
    ],
  };
  const before = structuredClone(f.graph);
  const result = await f.service.preview(await f.input(command), () => {});
  expect(result.counts).toMatchObject({
    entriesRemoved: 2,
    entriesUpdated: 1,
    manualEntriesPreserved: 1,
    referencesRemapped: 10,
  });
  expect(result.entries.some((row) => row.entryId === "manual")).toBe(false);
  expect(f.graph).toEqual(before);
  await expect(
    f.service.preview(await f.input({ ...command, mappings: [] }), () => {}),
  ).rejects.toThrow("explicit destination or unlink");
});

it("supports an explicit empty replacement with unlink mappings, without deleting protected entries", async () => {
  const f = migrationFixture();
  const result = await f.service.preview(
    await f.input({
      kind: "replace-glossary",
      entries: [],
      mappings: [
        { fromId: "old", toId: null },
        { fromId: "keep", toId: null },
        { fromId: "__proto__", toId: null },
      ],
    }),
    () => {},
  );
  expect(result.counts).toMatchObject({
    entriesRemoved: 3,
    manualEntriesPreserved: 1,
    referencesUnlinked: 12,
  });
});

it("does not infer identity from matching character names in a replacement", async () => {
  const f = migrationFixture();
  const entry = {
    id: "new-character",
    displayName: "old-character",
    sourceNames: [],
    targetName: "new",
    speechStyle: "neutral",
    enabled: true,
  };
  await expect(
    f.service.preview(
      await f.input({ kind: "replace-characters", entries: [entry] }),
      () => {},
    ),
  ).rejects.toThrow("explicit destination or unlink");
  const result = await f.service.preview(
    await f.input({
      kind: "replace-characters",
      entries: [entry],
      mappings: [{ fromId: "old-character", toId: "new-character" }],
    }),
    () => {},
  );
  expect(result.counts).toMatchObject({
    entriesAdded: 1,
    entriesRemoved: 2,
    referencesRemapped: 6,
  });
});

it.each(
  [
    [{ fromId: "old", toId: "absent" }],
    [{ fromId: "absent", toId: "keep" }],
    [{ fromId: "manual", toId: "keep" }],
    [{ fromId: "keep", toId: "keep" }],
    [
      { fromId: "old", toId: "keep" },
      { fromId: "old", toId: null },
    ],
  ].map((mappings) => ({ mappings })),
)(
  "rejects unknown retained self-referential or duplicate mappings %j",
  async ({ mappings }) => {
    const f = migrationFixture();
    await expect(
      f.service.preview(
        await f.input({ kind: "replace-glossary", entries: [keep], mappings }),
        () => {},
      ),
    ).rejects.toThrow();
  },
);

it("rejects disabled destinations, chains, and cycles instead of guessing a terminal ID", async () => {
  const f = migrationFixture();
  f.graph.styleGuide.glossary[1].enabled = false;
  await expect(
    f.service.preview(await f.input(merge), () => {}),
  ).rejects.toThrow("enabled destination");
  await expect(
    f.service.preview(
      await f.input({
        kind: "replace-glossary",
        entries: [{ ...keep, enabled: false }],
        mappings: [{ fromId: "old", toId: "keep" }],
      }),
      () => {},
    ),
  ).rejects.toThrow("enabled surviving");
  await expect(
    f.service.preview(
      await f.input({
        kind: "replace-glossary",
        entries: [],
        mappings: [
          { fromId: "old", toId: "keep" },
          { fromId: "keep", toId: "old" },
        ],
      }),
      () => {},
    ),
  ).rejects.toThrow("Chains and cycles");
});

it("rejects duplicate saved and replacement catalog IDs without changing either catalog", async () => {
  const f = migrationFixture();
  await expect(
    f.service.preview(
      await f.input({ kind: "replace-glossary", entries: [keep, keep] }),
      () => {},
    ),
  ).rejects.toThrow("Duplicate catalog");
  f.graph.styleGuide.glossary.push({ ...f.graph.styleGuide.glossary[0] });
  const before = structuredClone(f.graph);
  await expect(
    f.service.preview(await f.input(merge), () => {}),
  ).rejects.toThrow("Duplicate catalog");
  expect(f.graph).toEqual(before);
});

it("treats prototype-looking entry IDs as data rather than object properties", async () => {
  const f = migrationFixture();
  const result = await f.service.preview(
    await f.input(
      { ...merge, sourceIds: ["__proto__"] },
      { section: "references" },
    ),
    () => {},
  );
  expect(result.counts.referencesRemapped).toBe(2);
  expect(result.references.every((row) => row.entryId === "__proto__")).toBe(
    true,
  );
  expect(Object.prototype).not.toHaveProperty("target");
});

it("copies and deduplicates aliases only when requested, without merging notes or translation fields", async () => {
  const f = migrationFixture();
  f.graph.styleGuide.glossary[0].aliases = ["old", "alias"];
  f.graph.styleGuide.glossary[1].note = "destination note";
  const untouched = await f.service.preview(await f.input(merge), () => {});
  expect(untouched.counts.entriesUpdated).toBe(0);
  const result = await f.service.preview(
    await f.input({ ...merge, copyAliases: true }),
    () => {},
  );
  const target = result.entries.find((row) => row.entryId === "keep");
  expect(target?.after).toMatchObject({
    source: "keep",
    target: "target keep",
    aliases: ["old", "alias"],
    note: "destination note",
  });
});

it("never truncates oversized alias unions or modifies a protected alias destination", async () => {
  const f = migrationFixture();
  f.graph.styleGuide.glossary[0].aliases = Array.from(
    { length: 50 },
    (_, n) => `alias-${n}`,
  );
  await expect(
    f.service.preview(await f.input({ ...merge, copyAliases: true }), () => {}),
  ).rejects.toThrow("native limits");
  delete f.graph.styleGuide.glossary[0].aliases;
  await expect(
    f.service.preview(
      await f.input({ ...merge, targetId: "manual", copyAliases: true }),
      () => {},
    ),
  ).rejects.toThrow("protected");
  expect(
    (
      await f.service.preview(
        await f.input({ ...merge, targetId: "manual" }),
        () => {},
      )
    ).counts.entriesUpdated,
  ).toBe(0);
});

it("requires exact whole-work evidence and a matching intent for paginated previews", async () => {
  const f = migrationFixture();
  const input = await f.input(merge, { section: "references", limit: 1 });
  const first = await f.service.preview(input, () => {});
  expect(first.nextOffset).toBe(1);
  const next = await f.service.preview(
    { ...input, offset: 1, planFingerprint: first.planFingerprint },
    () => {},
  );
  expect(next.references).toHaveLength(1);
  await expect(
    f.service.preview({ ...input, offset: 1 }, () => {}),
  ).rejects.toThrow("Continuation");
  await expect(
    f.service.preview(
      {
        ...input,
        preserveManual: false,
        offset: 1,
        planFingerprint: first.planFingerprint,
      },
      () => {},
    ),
  ).rejects.toThrow("intent changed");
  f.graph.chapters[1].chapter.pages[0].blocks[1].translatedText = "later edit";
  await expect(f.service.preview(input, () => {})).rejects.toThrow(
    "another chapter changed",
  );
});

it("does not accept a filtered reference fingerprint as complete migration evidence", async () => {
  const f = migrationFixture();
  const input = await f.input(merge);
  const filtered = await f.references.inspect(
    McpContextReferencesSchema.parse({
      chapterId: "chapter",
      entity: "glossary",
    }),
    () => {},
  );
  await expect(
    f.service.preview(
      { ...input, referenceSnapshot: filtered.snapshot },
      () => {},
    ),
  ).rejects.toThrow("unfiltered");
});

it("ignores transient default-root timestamps while preserving optional fields and identical replacements", async () => {
  const f = migrationFixture();
  const input = await f.input(merge);
  const first = await f.service.preview(input, () => {});
  f.graph.styleGuide.createdAt = "regenerated";
  f.graph.styleGuide.updatedAt = "regenerated";
  for (const item of f.graph.chapters)
    item.storyMemory.updatedAt = "regenerated";
  expect((await f.service.preview(input, () => {})).planFingerprint).toBe(
    first.planFingerprint,
  );
  expect(f.graph.styleGuide.glossary[1]).not.toHaveProperty("aliases");
});

it("checks authority before reading and after the asynchronous native snapshot", async () => {
  const f = migrationFixture();
  const input = await f.input(merge);
  f.read.mockClear();
  const denied = () => {
    throw new Error("revoked");
  };
  await expect(f.service.preview(input, denied)).rejects.toThrow("revoked");
  expect(f.read).not.toHaveBeenCalled();
  const guard = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(denied);
  await expect(f.service.preview(input, guard)).rejects.toThrow("revoked");
  expect(f.read).toHaveBeenCalledTimes(1);
});

it.each([
  { path: "C:/private" },
  { apply: true },
  { owner: "other" },
  { engine: "remote" },
  { referenceSnapshot: "not-a-snapshot" },
  { limit: 0 },
  { preserveManual: "false" },
])(
  "rejects undeclared or invalid migration preview parameters %j",
  async (extra) => {
    const f = migrationFixture();
    const input = await f.input(merge);
    expect(
      McpContextMigrationPreviewSchema.safeParse({ ...input, ...extra })
        .success,
    ).toBe(false);
  },
);
