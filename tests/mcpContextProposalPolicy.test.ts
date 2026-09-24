import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { migrationFixture } from "./mcpContextMigration.fixture";
import {
  McpContextPreviewSchema,
  mcpContextRevision,
} from "../src/shared/mcpContextEditing";
import {
  createContextProposal,
  selectContextProposal,
  buildContextProposalCommit,
  type ContextProposalEntry,
} from "../src/main/application/mcpContextProposalPolicy";

function fixture(
  source: "edit" | "external-research" | "app-research" = "external-research",
) {
  const graph = migrationFixture().graph;
  const snapshot = { ...graph, ...graph.chapters[0] };
  const request = McpContextPreviewSchema.parse({
    chapterId: snapshot.chapter.id,
    revision: mcpContextRevision(snapshot),
    requestId: randomUUID(),
    changes: [
      {
        changeId: "__proto__",
        entity: "glossary",
        values: { source: "new term", target: "new name" },
      },
      {
        changeId: "existing",
        entity: "character",
        entryId: "keep-character",
        values: { targetName: "reviewed name" },
      },
    ],
  });
  const now = Date.parse("2026-09-20T00:00:00.000Z");
  const entry = createContextProposal(
    snapshot,
    "owner",
    request,
    source,
    [
      {
        changeId: "__proto__",
        reason: "Reference only, not a page event",
        sources: [
          { title: "Fixture reference", url: "https://example.com/fixture" },
        ],
      },
    ],
    ["caller-supplied evidence"],
    "0123456789abcdef",
    now,
    1800000,
  );
  const apply = {
    proposalId: entry.metadata.proposalId,
    requestId: randomUUID(),
    selectedChangeIds: ["__proto__", "existing"],
  };
  return { snapshot, request, entry, now, apply };
}

for (const source of ["edit", "external-research", "app-research"] as const) {
  it(`preserves ${source} review semantics, own-property IDs and selected results after JSON roundtrip`, () => {
    const f = fixture(source);
    const before = structuredClone(f.snapshot);
    const hydrated: ContextProposalEntry = JSON.parse(JSON.stringify(f.entry));
    expect(hydrated.metadata).toEqual(f.entry.metadata);
    expect(Object.hasOwn(hydrated.options.entryIds, "__proto__")).toBe(true);
    const original = buildContextProposalCommit(
      f.snapshot,
      f.entry,
      selectContextProposal(f.entry, f.apply),
      f.apply,
      f.now + 10,
      () => {},
    );
    const restored = buildContextProposalCommit(
      f.snapshot,
      hydrated,
      selectContextProposal(hydrated, f.apply),
      f.apply,
      f.now + 10,
      () => {},
    );
    expect(restored).toEqual(original);
    expect(restored.result.changesApplied).toBe(2);
    expect(restored.styleGuide?.glossary.at(-1)?.id).toBe(
      hydrated.options.entryIds.__proto__,
    );
    expect(restored.styleGuide?.glossary.at(-1)?.origin).toBe(
      source === "edit" ? "manual" : "ai",
    );
    expect(restored).not.toHaveProperty("storyMemory");
    expect(f.snapshot).toEqual(before);
  });
}

it("keeps unselected changes, existing manual content and evidence separate from saved catalog fields", () => {
  const f = fixture();
  f.apply.selectedChangeIds = ["existing"];
  const planned = buildContextProposalCommit(
    f.snapshot,
    f.entry,
    selectContextProposal(f.entry, f.apply),
    f.apply,
    f.now + 1,
    () => {},
  );
  expect(planned.styleGuide?.glossary).toEqual(f.snapshot.styleGuide.glossary);
  expect(planned.styleGuide?.characters[1]).toMatchObject({
    targetName: "reviewed name",
    origin: "ai",
  });
  expect(JSON.stringify(planned.styleGuide)).not.toContain("example.com");
  expect(planned.result.changesApplied).toBe(1);
});

it("rejects duplicate, unknown and already-applied selections without mutating the review", () => {
  const f = fixture();
  const before = structuredClone(f.entry);
  for (const ids of [["existing", "existing"], ["unknown"]])
    expect(() =>
      selectContextProposal(f.entry, { ...f.apply, selectedChangeIds: ids }),
    ).toThrow("distinct change IDs");
  const result = buildContextProposalCommit(
    f.snapshot,
    f.entry,
    selectContextProposal(f.entry, f.apply),
    f.apply,
    f.now,
    () => {},
  ).result;
  expect(() =>
    selectContextProposal({ ...f.entry, applied: result }, f.apply),
  ).toThrow("already applied");
  expect(f.entry).toEqual(before);
});

it("rejects tampered reviewed fields or regenerated entry IDs and rechecks authority", () => {
  const f = fixture();
  for (const mode of ["id", "review"] as const) {
    const entry = structuredClone(f.entry);
    if (mode === "id") entry.options.entryIds.__proto__ = randomUUID();
    else entry.changes[0].after.target = "unreviewed replacement";
    expect(() =>
      buildContextProposalCommit(
        f.snapshot,
        entry,
        selectContextProposal(entry, f.apply),
        f.apply,
        f.now,
        () => {},
      ),
    ).toThrow("reviewed result");
  }
  const guard = vi.fn(() => {
    throw new Error("revoked");
  });
  expect(() =>
    buildContextProposalCommit(
      f.snapshot,
      f.entry,
      selectContextProposal(f.entry, f.apply),
      f.apply,
      f.now,
      guard,
    ),
  ).toThrow("revoked");
  expect(guard).toHaveBeenCalledOnce();
});

it("rejects stale catalog content instead of converting the old review into a fresh approval", () => {
  const f = fixture();
  f.snapshot.styleGuide.characters[0].note = "subsequent user edit";
  expect(() =>
    buildContextProposalCommit(
      f.snapshot,
      f.entry,
      selectContextProposal(f.entry, f.apply),
      f.apply,
      f.now,
      () => {},
    ),
  ).toThrow("Context changed");
});

it("keeps the existing 256-KiB review budget before admitting an oversized proposal", () => {
  const f = fixture();
  const input = McpContextPreviewSchema.parse({
    ...f.request,
    changes: Array.from({ length: 100 }, (_, index) => ({
      changeId: `large-${index}`,
      entity: "glossary",
      values: {
        source: `term-${index}`,
        note: "n".repeat(2000),
        aliases: Array.from({ length: 20 }, () => "a".repeat(200)),
      },
    })),
  });
  const before = structuredClone(f.snapshot);
  expect(() =>
    createContextProposal(
      f.snapshot,
      "owner",
      input,
      "external-research",
      [],
      [],
      "0123456789abcdef",
      f.now,
      1800000,
    ),
  ).toThrow("Proposal is too large");
  expect(f.snapshot).toEqual(before);
});
