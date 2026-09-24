import { expect, it } from "vitest";
import { formatBatchFixture } from "./mcpFormatBatch.fixture";
import {
  matchesMcpFormat,
  McpFormatFilterSchema,
} from "../src/shared/mcpFormatEditing";
import { applyMcpFormatSnapshots } from "../src/main/application/mcpFormatBatchPolicy";
import { createPageRevision } from "../src/shared/pageRevision";

it.each([
  ["equals", 24, true],
  ["notEquals", 24, false],
  ["lt", 25, true],
  ["lte", 24, true],
  ["gt", 23, true],
  ["gte", 24, true],
  ["gt", 24, false],
  ["lte", 23, false],
] as const)(
  "matches %s %s according to the app field registry",
  async (operator, value, result) => {
    const f = formatBatchFixture();
    try {
      const page = f.chapter.pages[0],
        block = page.blocks[0];
      block.fontSizePx = 24;
      const filter = McpFormatFilterSchema.parse({
        conditions: [{ field: "fontSizePx", operator, value }],
      });
      expect(matchesMcpFormat(page, block, filter)).toBe(result);
    } finally {
      await f.close();
    }
  },
);
it("rejects internal whole-content replacement, duplicate IDs and absent blocks", async () => {
  const f = formatBatchFixture();
  try {
    const page = f.chapter.pages[0],
      before = structuredClone(page);
    const request = {
      chapterId: f.chapter.id,
      pageId: page.id,
      revision: createPageRevision(page),
    };
    const original = structuredClone(page.blocks[0]);
    for (const blocks of [
      [],
      [original, original],
      [{ ...original, id: "missing" }],
      [{ ...original, translatedText: "must not overwrite" }],
      [{ ...original, bbox: { ...original.bbox, w: original.bbox.w + 1 } }],
    ])
      expect(() =>
        applyMcpFormatSnapshots(page, { ...request, blocks }),
      ).toThrow();
    expect(page).toEqual(before);
  } finally {
    await f.close();
  }
});
it("keeps excluded large image assets out of history and reports true no-ops", async () => {
  const f = formatBatchFixture();
  try {
    f.chapter.pages[0].blocks[0].generatedLettering = {
      version: 1,
      dataUrl: "PRIVATE".repeat(1024 * 1024),
      sourceText: "source",
      translatedText: "lettering",
    };
    const input = f.request();
    input.pages = [input.pages[0]];
    const plan = await f.service.preview(f.owner, input, f.guard);
    expect(plan.excludedChanges).toBe(1);
    expect(plan.canApply).toBe(false);
    expect(JSON.stringify(await f.inspect(plan.batchId))).not.toContain(
      "PRIVATE",
    );
    const noop = f.request();
    noop.pages = [noop.pages[1]];
    noop.pages[0].edits[0].fields = {
      textColor: f.chapter.pages[1].blocks[0].textColor,
    };
    const unchanged = await f.service.preview(f.owner, noop, f.guard);
    expect(unchanged.canApply).toBe(false);
    expect(unchanged.pages[0].state).toBe("unchanged");
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("refuses Undo after a later user edit and preserves literal inline markup", async () => {
  const f = formatBatchFixture();
  try {
    f.chapter.pages[0].blocks[0].translatedText =
      "<b>Keep</b> {{literal}} text";
    const input = f.request();
    const plan = await f.service.preview(f.owner, input, f.guard);
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe(
      "<b>Keep</b> {{literal}} text",
    );
    f.chapter.pages[0].blocks[1].translatedText = "user's newer edit";
    f.start(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("failed");
    expect(f.chapter.pages[0].blocks[1].translatedText).toBe(
      "user's newer edit",
    );
  } finally {
    await f.close();
  }
});
