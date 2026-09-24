import { expect, it } from "vitest";
import { formatBatchFixture } from "./mcpFormatBatch.fixture";
import { searchMcpChapterText } from "../src/main/application/mcpChapterTextSearch";
import {
  McpChapterTextSearchSchema,
  mcpTranslationBatchOutputs,
} from "../src/shared/mcpTranslationBatch";
import {
  McpFormatFilterSchema,
  McpFormatEditSchema,
} from "../src/shared/mcpFormatEditing";

it("searches app-effective defaults and stored values separately without writes", async () => {
  const f = formatBatchFixture();
  try {
    for (const page of f.chapter.pages)
      for (const block of page.blocks) delete block.letterSpacing;
    const before = structuredClone(f.saved);
    const input = McpChapterTextSearchSchema.parse({
      chapterId: f.chapter.id,
      mode: "browse",
      format: {
        conditions: [{ field: "letterSpacing", operator: "equals", value: 0 }],
      },
      limit: 1,
    });
    const first = searchMcpChapterText(f.saved, input);
    expect(first.total).toBe(6);
    expect(first.matches[0].format.stored.letterSpacing).toBeUndefined();
    expect(first.matches[0].format.effective.letterSpacing).toBe(0);
    expect(
      mcpTranslationBatchOutputs.carrot_search_chapter_text.safeParse(first)
        .success,
    ).toBe(true);
    const next = searchMcpChapterText(f.saved, {
      ...input,
      snapshot: first.snapshot,
      offset: 1,
    });
    expect(next.matches[0].blockId).not.toBe(first.matches[0].blockId);
    const stored = McpChapterTextSearchSchema.parse({
      ...input,
      format: { ...input.format, basis: "stored" },
    });
    expect(searchMcpChapterText(f.saved, stored).total).toBe(0);
    expect(() =>
      searchMcpChapterText(f.saved, {
        ...stored,
        snapshot: first.snapshot,
        offset: 1,
      }),
    ).toThrow(/changed/);
    expect(f.saved).toEqual(before);
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("combines numeric bounds, manual-size filtering and text search with snapshot validation", async () => {
  const f = formatBatchFixture();
  try {
    const block = f.chapter.pages[0].blocks[0];
    block.fontSizePx = 34;
    block.fontSizeIntent = "manual";
    const input = McpChapterTextSearchSchema.parse({
      chapterId: f.chapter.id,
      mode: "browse",
      format: {
        manualFontSize: "only",
        conditions: [
          { field: "fontSizePx", operator: "gte", value: 34 },
          { field: "fontSizePx", operator: "lt", value: 35 },
        ],
      },
    });
    const found = searchMcpChapterText(f.saved, input);
    expect(found.total).toBe(1);
    expect(found.matches[0].format.fontSizeIntent).toBe("manual");
    block.fontSizePx = 40;
    expect(() =>
      searchMcpChapterText(f.saved, {
        ...input,
        offset: 1,
        snapshot: found.snapshot,
      }),
    ).toThrow(/changed/);
    expect(searchMcpChapterText(f.saved, input).total).toBe(0);
  } finally {
    await f.close();
  }
});
it.each([
  { field: "fontFamily", operator: "lt", value: "test" },
  { field: "fontSizePx", operator: "equals", value: "big" },
  { field: "bold", operator: "equals", value: 1 },
  { field: "sourceText", operator: "equals", value: "never" },
  { field: "fontSizePx", operator: "gt", value: Infinity },
])("rejects malformed format condition %j", (condition) => {
  expect(
    McpFormatFilterSchema.safeParse({ conditions: [condition] }).success,
  ).toBe(false);
});
it("rejects text, review, erasure and empty patches at the format-only boundary", () => {
  for (const fields of [
    { sourceText: "x" },
    { translatedText: "x" },
    { reviewNote: "x" },
    { inpaintExcluded: true },
    {},
  ])
    expect(
      McpFormatEditSchema.safeParse({ blockId: "a", reason: "edit", fields })
        .success,
    ).toBe(false);
  expect(
    McpFormatEditSchema.safeParse({
      blockId: "a",
      reason: "edit",
      fields: { bold: false },
    }).success,
  ).toBe(true);
});
