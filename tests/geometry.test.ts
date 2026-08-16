import { describe, expect, it } from "vitest";
import {
  constrainEditableRenderBbox,
  isEditableBlockVisibleOnPage,
} from "../src/shared/editableRenderGeometry";
import {
  applyEditableBlockBbox,
  applyMovedEditableBlockBbox,
  bboxOverlapRatio,
  clampBbox,
  enforceRenderDirection,
  estimateBlockFontSizePx,
  normalizeRotationDeg,
  normalizeBlockType,
  normalizeRenderDirection,
  offsetBlockBboxes,
  resolveBlockSelectionBoundary,
  resolveBlockSelectionBounds,
  resolveEditableBlockBbox,
  resolveEffectiveRenderBbox,
  resolveBlockRenderBbox,
  sanitizeChapterBboxes,
} from "../src/shared/geometry";

describe("geometry helpers", () => {
  it.each([
    {
      name: "zero-width box",
      a: { x: 0, y: 0, w: 0, h: 10 },
      b: { x: 0, y: 0, w: 10, h: 10 },
    },
    {
      name: "negative-size box",
      a: { x: 0, y: 0, w: -10, h: -10 },
      b: { x: 0, y: 0, w: 10, h: 10 },
    },
    {
      name: "disjoint boxes",
      a: { x: 0, y: 0, w: 10, h: 10 },
      b: { x: 20, y: 20, w: 10, h: 10 },
    },
    {
      name: "edge-touching boxes",
      a: { x: 0, y: 0, w: 10, h: 10 },
      b: { x: 10, y: 0, w: 10, h: 10 },
    },
  ])("returns zero for $name", ({ a, b }) => {
    expect(bboxOverlapRatio(a, b)).toBe(0);
  });

  it("returns one when either valid box fully contains the other", () => {
    const outer = { x: 0, y: 0, w: 10, h: 10 };
    const inner = { x: 2, y: 2, w: 4, h: 4 };

    expect(bboxOverlapRatio(outer, inner)).toBe(1);
    expect(bboxOverlapRatio(inner, outer)).toBe(1);
  });

  it("measures partial overlap relative to the smaller box", () => {
    expect(
      bboxOverlapRatio(
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 5, y: 0, w: 10, h: 10 },
      ),
    ).toBe(0.5);
  });

  it("preserves the one-unit denominator floor for sub-unit boxes", () => {
    const tiny = { x: 0, y: 0, w: 0.5, h: 0.5 };

    expect(bboxOverlapRatio(tiny, tiny)).toBe(0.25);
  });

  it("clamps normalized boxes to the 0-1000 coordinate space", () => {
    expect(clampBbox({ x: -30, y: 10, w: 1200, h: 1500 })).toEqual({
      x: 0,
      y: 10,
      w: 1000,
      h: 990,
    });
  });

  it("keeps boxes valid when dragged to the bottom-right edge", () => {
    expect(clampBbox({ x: 1000, y: 1000, w: 0, h: 0 })).toEqual({
      x: 999,
      y: 999,
      w: 1,
      h: 1,
    });
    expect(clampBbox({ x: 999.8, y: 999.4, w: 4, h: 4 })).toEqual({
      x: 999,
      y: 999,
      w: 1,
      h: 1,
    });
  });

  it("normalizes invalid saved chapter block boxes before IPC validation", () => {
    const chapter = sanitizeChapterBboxes({
      id: "11111111-1111-4111-8111-111111111111",
      workId: "22222222-2222-4222-8222-222222222222",
      title: "chapter",
      sourceKind: "images",
      status: "idle",
      pageOrder: ["33333333-3333-4333-8333-333333333333"],
      pages: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "page.png",
          imagePath: "C:/page.png",
          dataUrl: "",
          width: 1000,
          height: 1000,
          analysisStatus: "completed",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          blocks: [
            {
              id: "block-1",
              type: "nonsolid",
              bbox: { x: 1000, y: 1000, w: 0, h: 0 },
              renderBbox: { x: 1000, y: 1000, w: 0, h: 0 },
              sourceText: "",
              translatedText: "",
              confidence: 1,
              sourceDirection: "vertical",
              renderDirection: "horizontal",
              fontSizePx: 24,
              lineHeight: 1.18,
              textAlign: "center",
              textColor: "#111111",
              backgroundColor: "#fffdf5",
              opacity: 0.8,
            },
          ],
        },
      ],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(chapter.pages[0].blocks[0].bbox).toEqual({
      x: 999,
      y: 999,
      w: 1,
      h: 1,
    });
    expect(chapter.pages[0].blocks[0].renderBbox).toEqual({
      x: 992,
      y: 992,
      w: 1,
      h: 1,
    });
    expect(chapter.pages[0].blocks[0].bboxSpace).toBe("normalized_1000");
    expect(chapter.pages[0].blocks[0].renderBboxSpace).toBe("normalized_1000");
  });

  it("uses renderBbox when a dedicated layout box exists", () => {
    expect(
      resolveBlockRenderBbox({
        bbox: { x: 100, y: 120, w: 180, h: 220 },
        renderBbox: { x: 80, y: 100, w: 240, h: 280 },
      }),
    ).toEqual({ x: 80, y: 100, w: 240, h: 280 });
  });

  it("converts pixel-space boxes into normalized page coordinates", () => {
    expect(
      resolveBlockRenderBbox(
        {
          bbox: { x: 240, y: 360, w: 120, h: 180 },
          bboxSpace: "pixels",
        },
        { width: 1200, height: 1800 },
      ),
    ).toEqual({ x: 200, y: 200, w: 100, h: 100 });
  });

  it("expands an effective render box for tiny source boxes without changing the source bbox", () => {
    const block = {
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      bboxSpace: "normalized_1000" as const,
      renderDirection: "horizontal" as const,
      lineHeight: 1.18,
      autoFitText: true,
    };
    const effective = resolveEffectiveRenderBbox(
      block,
      { width: 1000, height: 1000 },
      "가나다",
    );

    expect(block.bbox).toEqual({ x: 100, y: 100, w: 4, h: 4 });
    expect(effective.w).toBeGreaterThan(block.bbox.w);
    expect(effective.h).toBeGreaterThan(block.bbox.h);
    expect(
      resolveEditableBlockBbox(block, { width: 1000, height: 1000 }, "가나다")
        .key,
    ).toBe("renderBbox");
  });

  it("respects an explicit renderBbox as a manual layout box", () => {
    const block = {
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      renderBbox: { x: 80, y: 90, w: 8, h: 8 },
      renderBboxSpace: "normalized_1000" as const,
      renderDirection: "horizontal" as const,
      lineHeight: 1.18,
    };

    expect(
      resolveEffectiveRenderBbox(
        block,
        { width: 1000, height: 1000 },
        "가나다라마바사",
      ),
    ).toEqual(block.renderBbox);
  });

  it("resolves selection bounds from the displayed render frame and rotation", () => {
    const bounds = resolveBlockSelectionBounds(
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 100, y: 100, w: 80, h: 80 },
        renderBbox: { x: 400, y: 400, w: 200, h: 100 },
        renderBboxSpace: "normalized_1000",
        sourceText: "원문",
        translatedText: "번역",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        rotationDeg: 90,
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
      { width: 1000, height: 1000 },
    );

    expect(bounds.x).toBeCloseTo(450);
    expect(bounds.y).toBeCloseTo(350);
    expect(bounds.w).toBeCloseTo(100);
    expect(bounds.h).toBeCloseTo(200);
  });

  it("resolves selection geometry when only source text or placeholder text is available", () => {
    const sourceOnlyBlock = {
      id: "block-source-only",
      type: "nonsolid" as const,
      bbox: { x: 100, y: 100, w: 80, h: 80 },
      renderBbox: { x: 400, y: 420, w: 180, h: 120 },
      renderBboxSpace: "normalized_1000" as const,
      sourceText: "원문",
      translatedText: "",
      confidence: 1,
      sourceDirection: "horizontal" as const,
      renderDirection: "horizontal" as const,
      fontSizePx: 24,
      lineHeight: 1.18,
      textAlign: "center" as const,
      textColor: "#111111",
      backgroundColor: "#ffffff",
      opacity: 1,
    };
    const pageSize = { width: 1000, height: 1000 };

    expect(resolveBlockSelectionBounds(sourceOnlyBlock, pageSize)).toEqual(
      sourceOnlyBlock.renderBbox,
    );
    expect(resolveBlockSelectionBoundary(sourceOnlyBlock, pageSize)[0]).toEqual(
      { x: 400, y: 420 },
    );

    const emptyBlock = { ...sourceOnlyBlock, sourceText: "" };
    expect(resolveBlockSelectionBounds(emptyBlock, pageSize)).toEqual(
      emptyBlock.renderBbox,
    );
    expect(resolveBlockSelectionBoundary(emptyBlock, pageSize)[0]).toEqual({
      x: 400,
      y: 420,
    });
  });

  it("estimates a larger font size for a larger render box", () => {
    const bboxOnly = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        bbox: { x: 100, y: 100, w: 80, h: 100 },
      },
      { width: 1000, height: 1600 },
    );
    const withRenderBbox = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        bbox: { x: 100, y: 100, w: 80, h: 100 },
        renderBbox: { x: 80, y: 80, w: 240, h: 240 },
      },
      { width: 1000, height: 1600 },
    );

    expect(withRenderBbox).toBeGreaterThan(bboxOnly);
  });

  it("updates renderBbox first when dragging a block with a dedicated layout box", () => {
    const next = applyEditableBlockBbox(
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 100, y: 100, w: 80, h: 120 },
        renderBbox: { x: 80, y: 90, w: 220, h: 260 },
        sourceText: "",
        translatedText: "",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8,
      },
      { x: 120, y: 140, w: 240, h: 280 },
    );

    expect(next.bbox).toEqual({ x: 100, y: 100, w: 80, h: 120 });
    expect(next.renderBbox).toEqual({ x: 120, y: 140, w: 240, h: 280 });
  });

  it("moves only the render box and preserves OCR source geometry", () => {
    const next = applyMovedEditableBlockBbox(
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 100, y: 120, w: 80, h: 120 },
        renderBbox: { x: 80, y: 90, w: 220, h: 260 },
        sourceText: "원문",
        translatedText: "번역",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8,
      },
      { x: 130, y: 150, w: 220, h: 260 },
    );

    expect(next.bbox).toEqual({ x: 100, y: 120, w: 80, h: 120 });
    expect(next.renderBbox).toEqual({ x: 130, y: 150, w: 220, h: 260 });
  });

  it("lets the render box cross the source boundary independently", () => {
    const block = {
      id: "block-1",
      type: "nonsolid" as const,
      bbox: { x: 850, y: 100, w: 100, h: 100 },
      renderBbox: { x: 700, y: 80, w: 100, h: 140 },
      sourceText: "원문",
      translatedText: "번역",
      confidence: 1,
      sourceDirection: "vertical" as const,
      renderDirection: "horizontal" as const,
      fontSizePx: 24,
      lineHeight: 1.18,
      textAlign: "center" as const,
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 0.8,
    };
    const next = applyMovedEditableBlockBbox(block, {
      x: 800,
      y: 80,
      w: 100,
      h: 140,
    });

    expect(next.bbox).toEqual({ x: 850, y: 100, w: 100, h: 100 });
    expect(next.renderBbox).toEqual({ x: 800, y: 80, w: 100, h: 140 });
  });

  it("stores a temporary readable render box when dragging a tiny source-only block", () => {
    const block = {
      id: "block-1",
      type: "nonsolid" as const,
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      sourceText: "",
      translatedText: "가나다",
      confidence: 1,
      sourceDirection: "vertical" as const,
      renderDirection: "horizontal" as const,
      fontSizePx: 12,
      lineHeight: 1.18,
      textAlign: "center" as const,
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 0.8,
      autoFitText: true,
    };

    const next = applyEditableBlockBbox(
      block,
      { x: 120, y: 120, w: 80, h: 60 },
      { width: 1000, height: 1000 },
      block.translatedText,
    );

    expect(next.bbox).toEqual(block.bbox);
    expect(next.renderBbox).toEqual({ x: 120, y: 120, w: 80, h: 60 });
  });

  it("offsets only the editable render box when duplicating a block", () => {
    const duplicated = offsetBlockBboxes(
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 100, y: 100, w: 80, h: 120 },
        renderBbox: { x: 80, y: 90, w: 220, h: 260 },
        sourceText: "",
        translatedText: "",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8,
      },
      16,
      16,
    );

    expect(duplicated.bbox).toEqual({ x: 100, y: 100, w: 80, h: 120 });
    expect(duplicated.renderBbox).toEqual({ x: 96, y: 106, w: 220, h: 260 });
  });

  it("does not use the source boundary to limit a duplicated render box", () => {
    const duplicated = offsetBlockBboxes(
      {
        id: "block-1",
        type: "nonsolid",
        bbox: { x: 850, y: 100, w: 100, h: 100 },
        renderBbox: { x: 700, y: 80, w: 100, h: 140 },
        sourceText: "원문",
        translatedText: "번역",
        confidence: 1,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 24,
        lineHeight: 1.18,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#fffdf5",
        opacity: 0.8,
      },
      100,
      0,
    );

    expect(duplicated.bbox).toEqual({ x: 850, y: 100, w: 100, h: 100 });
    expect(duplicated.renderBbox).toEqual({
      x: 800,
      y: 80,
      w: 100,
      h: 140,
    });
  });

  it("keeps exactly eight normalized units recoverable at an outer edge", () => {
    const block = {
      id: "block-1",
      type: "nonsolid" as const,
      bbox: { x: 900, y: 900, w: 100, h: 100 },
      sourceText: "원문",
      translatedText: "번역",
      confidence: 1,
      sourceDirection: "horizontal" as const,
      renderDirection: "horizontal" as const,
      fontSizePx: 24,
      lineHeight: 1.18,
      textAlign: "center" as const,
      textColor: "#111111",
      backgroundColor: "#fffdf5",
      opacity: 0.8,
    };
    const moved = applyMovedEditableBlockBbox(block, {
      x: 2_000,
      y: -2_000,
      w: 100,
      h: 100,
    });

    expect(moved.bbox).toEqual(block.bbox);
    expect(moved.renderBbox).toEqual({ x: 992, y: -92, w: 100, h: 100 });
  });

  it("constrains the transformed outline rather than the unrotated box", () => {
    const block = { rotationDeg: 45 };
    const constrained = constrainEditableRenderBbox(block, {
      x: 1_200,
      y: 400,
      w: 240,
      h: 80,
    });

    expect(isEditableBlockVisibleOnPage(block, constrained)).toBe(true);
    expect(constrained.x).toBeLessThan(1_000);
  });

  it("normalizes old block kinds into the unified inpainting block type and allows manual direction controls", () => {
    expect(normalizeBlockType("speech")).toBe("nonsolid");
    expect(normalizeBlockType("caption")).toBe("nonsolid");
    expect(normalizeBlockType("sfx")).toBe("nonsolid");
    expect(enforceRenderDirection("nonsolid", "vertical")).toBe("vertical");
    expect(enforceRenderDirection("nonsolid", "rotated")).toBe("horizontal");
    expect(enforceRenderDirection("nonsolid", "hidden")).toBe("horizontal");
    expect(normalizeRenderDirection("vertical", "horizontal")).toBe("vertical");
    expect(normalizeRenderDirection("rotated", "vertical")).toBe("horizontal");
    expect(normalizeRenderDirection("hidden", "vertical")).toBe("horizontal");
    expect(normalizeRenderDirection("diagonal", "vertical")).toBe("vertical");
    expect(normalizeRenderDirection("diagonal", "horizontal")).toBe(
      "horizontal",
    );
  });

  it("normalizes full-circle rotation while preserving tenths of a degree", () => {
    expect(normalizeRotationDeg(0)).toBe(0);
    expect(normalizeRotationDeg(360)).toBe(0);
    expect(normalizeRotationDeg(-360)).toBe(0);
    expect(normalizeRotationDeg(450)).toBe(90);
    expect(normalizeRotationDeg(-450)).toBe(-90);
    expect(normalizeRotationDeg(180)).toBe(180);
    expect(normalizeRotationDeg(-180)).toBe(-180);
    expect(normalizeRotationDeg(540)).toBe(180);
    expect(normalizeRotationDeg(-540)).toBe(-180);
    expect(normalizeRotationDeg(181)).toBe(-179);
    expect(normalizeRotationDeg(12.34)).toBe(12.3);
    expect(normalizeRotationDeg("not-a-number")).toBe(0);
  });
});
