import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { formatBatchFixture } from "./mcpFormatBatch.fixture";
import { mcpFormatBatchOutputs } from "../src/shared/mcpFormatBatch";
import { applyMcpBlockPatch } from "../src/main/application/mcpBlockEditPolicy";

it("previews actual app styles, then applies/undoes/redoes exact optional typography without touching text", async () => {
  const f = formatBatchFixture();
  try {
    const before = structuredClone(f.saved);
    const input = f.request();
    input.preserveManualFontSize = false;
    input.pages[0].edits[0].fields = {
      fontSizePx: 38,
      bold: true,
      outlineWidthPx: 2,
    };
    input.pages[0].edits[0].renderRect = { x: 32, y: 50, w: 140, h: 80 };
    const planned = await f.service.preview(f.owner, input, f.guard);
    expect(f.saved).toEqual(before);
    expect(f.save).not.toHaveBeenCalled();
    const inspection = await f.inspect(planned.batchId);
    expect(
      mcpFormatBatchOutputs.carrot_get_format_batch.safeParse(inspection)
        .success,
    ).toBe(true);
    expect(JSON.stringify(inspection)).not.toMatch(
      /beforeBlock|afterBlock|imagePath|dataUrl/,
    );
    const expected = input.pages.map(
      (target, index) =>
        applyMcpBlockPatch(
          before.chapter,
          before.chapter.pages[index],
          target.edits,
        ).blocks,
    );
    const applied = f.start(planned.batchId, "apply");
    expect((await f.done(planned.batchId)).status).toBe("completed");
    expect(f.chapter.pages.map((page) => page.blocks)).toEqual(expected);
    for (const [index, page] of f.chapter.pages.entries()) {
      expect(page.blocks[0].sourceText).toBe(
        before.chapter.pages[index].blocks[0].sourceText,
      );
      expect(page.blocks[0].translatedText).toBe(
        before.chapter.pages[index].blocks[0].translatedText,
      );
      expect(page.blocks[1]).toEqual(before.chapter.pages[index].blocks[1]);
      expect(page.blockOrder).toEqual(before.chapter.pages[index].blockOrder);
    }
    const undo = f.start(planned.batchId, "undo");
    expect((await f.done(planned.batchId)).status).toBe("completed");
    expect(f.saved).toEqual(before);
    f.start(planned.batchId, "redo");
    await f.done(planned.batchId);
    expect(f.chapter.pages.map((page) => page.blocks)).toEqual(expected);
    expect(f.start(planned.batchId, "undo", undo.requestId).historical).toBe(
      true,
    );
    expect(
      (await f.inspect(planned.batchId)).pages.every(
        (page) => page.state === "applied",
      ),
    ).toBe(true);
    f.start(planned.batchId, "undo");
    await f.done(planned.batchId);
    expect(f.saved).toEqual(before);
    expect(
      f.start(planned.batchId, "apply", applied.requestId).historical,
    ).toBe(true);
    expect(f.saved).toEqual(before);
  } finally {
    await f.close();
  }
});
it("preserves manual sizes by default and excludes generated image lettering with explicit reasons", async () => {
  const f = formatBatchFixture();
  try {
    f.chapter.pages[0].blocks[0].fontSizeIntent = "manual";
    f.chapter.pages[1].blocks[0].generatedLettering = {
      version: 1,
      dataUrl: "PRIVATE_IMAGE",
      translatedText: "x",
      sourceText: "x",
    };
    const input = f.request();
    for (const page of input.pages) page.edits[0].fields = { fontSizePx: 39 };
    const plan = await f.service.preview(f.owner, input, f.guard);
    const view = await f.inspect(plan.batchId);
    expect(view.changes.map((item) => item.excludedReason)).toEqual([
      "manual_font_size_preserved",
      "generated_lettering",
      null,
    ]);
    expect(JSON.stringify(view)).not.toContain("PRIVATE_IMAGE");
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    expect(f.save).toHaveBeenCalledTimes(1);
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    input.requestId = randomUUID();
    input.preserveManualFontSize = false;
    const explicit = await f.service.preview(f.owner, input, f.guard);
    expect(explicit.excludedChanges).toBe(1);
  } finally {
    await f.close();
  }
});
it("stops on a changed middle page, records partial progress and restores only committed pages", async () => {
  const f = formatBatchFixture();
  try {
    const before = structuredClone(f.chapter.pages[0]);
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    f.chapter.pages[1].blocks[1].translatedText = "user later edit";
    f.start(plan.batchId, "apply");
    const done = await f.done(plan.batchId);
    expect(done.status).toBe("partial");
    expect(done.pages.map((page) => page.result)).toEqual([
      "saved",
      "failed",
      "not_started",
    ]);
    expect(done.pages[1].errorCode).toBe("revision_conflict");
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages[0]).toEqual(before);
    expect(f.chapter.pages[1].blocks[1].translatedText).toBe("user later edit");
  } finally {
    await f.close();
  }
});
it("records a committed page even when notification fails, allowing exact undo", async () => {
  const f = formatBatchFixture();
  try {
    const before = structuredClone(f.saved);
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    f.notify.mockImplementationOnce(() => {
      throw new Error("notification failed");
    });
    f.start(plan.batchId, "apply");
    const result = await f.done(plan.batchId);
    expect(result.status).toBe("partial");
    expect(result.pages[0].result).toBe("saved");
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.saved).toEqual(before);
  } finally {
    await f.close();
  }
});
it("rejects unsafe snapshots and stale context while allowing safe undo after context changes", async () => {
  const f = formatBatchFixture();
  try {
    const before = structuredClone(f.saved);
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    f.saved.styleGuide.rules.honorifics = "drop";
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages).toEqual(before.chapter.pages);
    f.start(plan.batchId, "redo");
    expect((await f.done(plan.batchId)).status).toBe("failed");
    expect(f.chapter.pages).toEqual(before.chapter.pages);
  } finally {
    await f.close();
  }
});
it("blocks cross-owner access, request collisions, stale previews, oversized and duplicate targets", async () => {
  const f = formatBatchFixture();
  try {
    const input = f.request();
    const plan = await f.service.preview(f.owner, input, f.guard);
    await expect(
      f.service.inspect("other", { batchId: plan.batchId }, f.guard),
    ).rejects.toThrow(/owned/);
    await expect(
      f.service.preview(f.owner, { ...input, reason: "different" }, f.guard),
    ).rejects.toThrow(/requestId/);
    const invalid = [
      {
        ...input,
        requestId: randomUUID(),
        pages: [input.pages[0], input.pages[0]],
      },
      {
        ...input,
        requestId: randomUUID(),
        pages: [{ ...input.pages[0], pageId: "absent" }],
      },
      {
        ...input,
        requestId: randomUUID(),
        pages: [
          {
            ...input.pages[0],
            edits: [input.pages[0].edits[0], input.pages[0].edits[0]],
          },
        ],
      },
      { ...input, requestId: randomUUID(), contextRevision: "f".repeat(16) },
      {
        ...input,
        requestId: randomUUID(),
        pages: [{ ...input.pages[0], revision: "page-v1:" + "f".repeat(16) }],
      },
    ];
    for (const value of invalid)
      await expect(
        f.service.preview(f.owner, value, f.guard),
      ).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
    f.advance(30 * 60_000 + 1);
    await expect(f.inspect(plan.batchId)).rejects.toThrow(/expired/);
  } finally {
    await f.close();
  }
});
