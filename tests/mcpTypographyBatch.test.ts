import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { typographyBatchFixture } from "./mcpTypographyBatch.fixture";
import {
  mcpTypographyBatchOutputs,
  McpTypographyBatchPreviewSchema,
} from "../src/shared/mcpTypographyBatch";
import { applyMcpTypographySnapshots } from "../src/main/application/mcpTypographyBatchPolicy";

it("plans without saving, selectively applies canonical font/size state and exactly restores optional absence", async () => {
  const f = typographyBatchFixture();
  const original = structuredClone(f.chapter.pages);
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    expect(plan.totalChanges).toBe(3);
    expect(f.save).not.toHaveBeenCalled();
    const view = await f.inspect(plan.batchId);
    expect(
      mcpTypographyBatchOutputs.carrot_get_typography_batch.safeParse(view)
        .success,
    ).toBe(true);
    expect(view.changes[0].after).toMatchObject({
      fontFamily: "jua",
      sourceFontFacePx: 25.83,
      fontSizeIntent: "source-match",
      autoFitText: false,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /sourceImageSha256|imagePath|beforeBlock|afterBlock|sourceText|translatedText/,
    );
    const action = randomUUID();
    f.start(plan.batchId, "apply", action);
    expect((await f.done(plan.batchId)).status).toBe("completed");
    const applied = structuredClone(f.chapter.pages);
    for (const [index, page] of applied.entries()) {
      expect(page.blocks[0].fontSizePx).toBe(
        original[index].blocks[0].fontSizePx,
      );
      expect(page.blocks[0].fontFamily).toBe("jua");
      expect(page.blocks[1]).toEqual(original[index].blocks[1]);
      expect(page.blocks[0].bbox).toEqual(original[index].blocks[0].bbox);
    }
    expect(f.commits[1].dependencies[0].revision).not.toBe(
      f.commits[0].dependencies[0].revision,
    );
    f.start(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(f.chapter.pages).toEqual(original);
    expect(
      Object.hasOwn(f.chapter.pages[0].blocks[0], "sourceFontFacePx"),
    ).toBe(false);
    const savedCount = f.save.mock.calls.length;
    expect(f.start(plan.batchId, "apply", action).historical).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(savedCount);
    expect(f.chapter.pages).toEqual(original);
    f.start(plan.batchId, "redo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(f.chapter.pages).toEqual(applied);
  } finally {
    await f.close();
  }
});

it.each(["font", "size"] as const)(
  "%s-only application preserves the other half of typography",
  async (mode) => {
    const f = typographyBatchFixture();
    const before = structuredClone(f.chapter.pages[0].blocks[0]);
    try {
      const input = f.request();
      input.pages = [input.pages[0]];
      input.pages[0].edits[0].mode = mode;
      const plan = await f.service.preview(f.owner, input, f.guard);
      f.start(plan.batchId, "apply");
      await f.done(plan.batchId);
      const block = f.chapter.pages[0].blocks[0];
      if (mode === "font") {
        expect(block.fontSizePx).toBe(before.fontSizePx);
        expect(block.autoFitText).toBe(before.autoFitText);
        expect(block.sourceFontFacePx).toBeUndefined();
      } else {
        expect(block.fontFamily).toBe(before.fontFamily);
        expect(block.fontWeight).toBe(before.fontWeight);
        expect(block.outlineColor).toBe(before.outlineColor);
        expect(block.sourceFontFacePx).toBe(25.83);
      }
    } finally {
      await f.close();
    }
  },
);

it("preserves manual size by default but applies explicit source-size overrides from measured evidence", async () => {
  const f = typographyBatchFixture();
  for (const page of f.chapter.pages) page.blocks[0].fontSizeIntent = "manual";
  f.refreshEvidence();
  try {
    const input = f.request();
    input.pages = [input.pages[0]];
    const plan = await f.service.preview(f.owner, input, f.guard);
    const view = await f.inspect(plan.batchId);
    expect(view.changes[0].sizeExclusion).toBe("manual_font_size_preserved");
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    expect(f.chapter.pages[0].blocks[0].fontSizeIntent).toBe("manual");
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    const override = {
      ...input,
      requestId: randomUUID(),
      preserveManualFontSize: false,
    };
    const explicit = await f.service.preview(f.owner, override, f.guard);
    f.start(explicit.batchId, "apply");
    await f.done(explicit.batchId);
    expect(f.chapter.pages[0].blocks[0].fontSizeIntent).toBe("source-match");
  } finally {
    await f.close();
  }
});

it.each(["block", "role"] as const)(
  "respects %s profile locks without applying a fallback font",
  async (type) => {
    const f = typographyBatchFixture();
    f.chapter.pages[0].blocks[0].fontRole = "dialogue";
    f.chapter.pages[0].blocks[0].fontRoleConfidence = 1;
    f.environment.profile.userLocks.push({
      id: "lock",
      scope:
        type === "block"
          ? { type, chapterId: f.chapter.id, pageId: "page", blockId: "a" }
          : { type, role: "dialogue" },
      selection: { fontId: "dohyeon", fontWeight: 700 },
      createdAt: "",
      updatedAt: "",
    });
    f.refreshEvidence();
    const before = structuredClone(f.chapter.pages[0].blocks[0]);
    try {
      const input = f.request();
      input.pages = [input.pages[0]];
      input.pages[0].edits[0].mode = "font";
      const plan = await f.service.preview(f.owner, input, f.guard);
      expect(plan.canApply).toBe(false);
      expect((await f.inspect(plan.batchId)).changes[0].fontExclusion).toBe(
        "manual_font_lock_or_unavailable_c23_choice",
      );
      expect(f.chapter.pages[0].blocks[0]).toEqual(before);
      expect(f.save).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("does not retain generated image payloads or apply missing evidence", async () => {
  const f = typographyBatchFixture();
  const block = f.chapter.pages[0].blocks[0];
  block.generatedLettering = {
    version: 1,
    dataUrl: "PRIVATE_IMAGE",
    sourceText: "x",
    translatedText: "y",
  };
  f.refreshEvidence();
  const observation = f.evidence();
  observation.pages[1].items[0] = {
    blockId: "a",
    font: null,
    estimate: null,
    fontExclusion: "no_available_c23_candidate",
    sizeExclusion: "insufficient_raster_evidence",
  };
  f.setEvidence(observation);
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    expect(plan.excludedChanges).toBe(2);
    const inspected = await f.inspect(plan.batchId);
    expect(JSON.stringify(inspected)).not.toContain("PRIVATE_IMAGE");
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0][0].pageId).toBe("third");
  } finally {
    await f.close();
  }
});

it.each(["sourceText", "bbox", "sourceFontFacePx", "fontFamily"])(
  "rejects unrequested %s changes at the internal snapshot boundary",
  async (field) => {
    const f = typographyBatchFixture();
    try {
      const input = f.request();
      input.pages = [input.pages[0]];
      const plan = await f.service.preview(f.owner, input, f.guard);
      f.start(plan.batchId, "apply");
      await f.done(plan.batchId);
      const request = structuredClone(f.commits[0]);
      if (field === "sourceText") request.blocks[0].sourceText = "forbidden";
      if (field === "bbox") request.blocks[0].bbox.x += 1;
      if (field === "sourceFontFacePx") {
        request.modes.a = "font";
        request.blocks[0].sourceFontFacePx = 99;
      }
      if (field === "fontFamily") {
        request.modes.a = "size";
        request.blocks[0].fontFamily = "different";
      }
      expect(() =>
        applyMcpTypographySnapshots(f.chapter.pages[0], request),
      ).toThrow();
    } finally {
      await f.close();
    }
  },
);

it("rejects whole-block remote payloads, expired observations and unobserved targets", async () => {
  const f = typographyBatchFixture();
  try {
    const input = f.request();
    expect(
      McpTypographyBatchPreviewSchema.safeParse({ ...input, blocks: [] })
        .success,
    ).toBe(false);
    input.pages[0].edits[0].blockId = "missing";
    await expect(
      f.service.preview(f.owner, input, f.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    f.advance(1800000);
    await expect(
      f.service.preview(f.owner, f.request(), f.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
