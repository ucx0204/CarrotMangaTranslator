import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { selectionEditingFixture } from "./mcpSelectionEditing.fixture";
import { projectMcpBlocks } from "../src/main/application/mcpEditPolicy";
import { McpSelectionBatchPreviewSchema } from "../src/shared/mcpSelectionEditing";

async function referenceFixture() {
  const f = await selectionEditingFixture();
  const guide = await f.library.getWorkStyleGuide("work");
  const metadata = {
    enabled: true,
    origin: "manual" as const,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
  guide.characters.push({
    ...metadata,
    id: "character-one",
    displayName: "First speaker",
    sourceNames: ["First"],
    targetName: "화자",
    speechStyle: "neutral",
  });
  guide.glossary.push({
    ...metadata,
    id: "term-one",
    source: "Term",
    target: "용어",
    category: "term",
  });
  await f.library.saveWorkStyleGuide(guide);
  return f;
}

it("links enabled native IDs, exposes saved references, then restores exact absence without any model", async () => {
  const f = await referenceFixture();
  try {
    const before = await f.snapshot();
    const input = await f.references({
      speakerId: "character-one",
      glossaryEntryIds: ["term-one"],
    });
    const plan = await f.preview(input);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = await f.snapshot();
    expect(projectMcpBlocks(after.pages[0], 0, 1)[0]).toMatchObject({
      speakerId: "character-one",
      glossaryEntryIds: ["term-one"],
    });
    const projected = projectMcpBlocks(after.pages[0], 0, 1)[0];
    projected.glossaryEntryIds?.push("external-mutation");
    expect(after.pages[0].blocks[0].glossaryEntryIds).toEqual(["term-one"]);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(
      before.pages.map((page) => page.blocks),
    );
    expect(f.request).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects unknown disabled or duplicate references and requires at least one explicit field", async () => {
  const f = await referenceFixture();
  try {
    const before = await readFile(f.chapterPath);
    for (const values of [
      { speakerId: "not-in-this-work" },
      { glossaryEntryIds: ["term-one", "term-one"] },
      {},
    ]) {
      await expect(f.preview(await f.references(values))).rejects.toThrow();
    }
    const guide = await f.library.getWorkStyleGuide("work");
    guide.characters[0].enabled = false;
    await f.library.saveWorkStyleGuide(guide);
    await expect(
      f.preview(await f.references({ speakerId: "character-one" })),
    ).rejects.toThrow(/enabled/i);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});

it("allows undo after context deletion but refuses forward reference use against changed context", async () => {
  const f = await referenceFixture();
  try {
    const before = await f.snapshot();
    const plan = await f.preview(
      await f.references({ speakerId: "character-one" }),
    );
    await f.action(plan.batchId, "apply");
    const guide = await f.library.getWorkStyleGuide("work");
    guide.characters = [];
    await f.library.saveWorkStyleGuide(guide);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(
      before.pages.map((page) => page.blocks),
    );
    expect((await f.action(plan.batchId, "redo")).result.status).toBe("failed");
  } finally {
    await f.close();
  }
});

it("keeps bounded explicit input contracts and does not accept caller-supplied raw blocks or replacement text", async () => {
  const f = await referenceFixture();
  try {
    const input = await f.references();
    expect(
      McpSelectionBatchPreviewSchema.safeParse({ ...input, blocks: [] })
        .success,
    ).toBe(false);
    const bad = structuredClone(input);
    bad.pages[0].edits = [
      { ...bad.pages[0].edits[0], translatedText: "unbound" } as never,
    ];
    expect(McpSelectionBatchPreviewSchema.safeParse(bad).success).toBe(false);
    const tooMany = {
      ...input,
      pages: Array.from({ length: 21 }, () => input.pages[0]),
    };
    expect(McpSelectionBatchPreviewSchema.safeParse(tooMany).success).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});
