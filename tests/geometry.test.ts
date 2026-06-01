import { describe, expect, it } from "vitest";
import {
  applyEditableBlockBbox,
  clampBbox,
  enforceRenderDirection,
  estimateBlockFontSizePx,
  normalizeBlockType,
  normalizeRenderDirection,
  offsetBlockBboxes,
  resolveEditableBlockBbox,
  resolveEffectiveRenderBbox,
  resolveBlockRenderBbox,
  sanitizeChapterBboxes
} from "../src/shared/geometry";

describe("geometry helpers", () => {
  it("clamps normalized boxes to the 0-1000 coordinate space", () => {
    expect(clampBbox({ x: -30, y: 10, w: 1200, h: 1500 })).toEqual({
      x: 0,
      y: 10,
      w: 1000,
      h: 990
    });
  });

  it("keeps boxes valid when dragged to the bottom-right edge", () => {
    expect(clampBbox({ x: 1000, y: 1000, w: 0, h: 0 })).toEqual({
      x: 999,
      y: 999,
      w: 1,
      h: 1
    });
    expect(clampBbox({ x: 999.8, y: 999.4, w: 4, h: 4 })).toEqual({
      x: 999,
      y: 999,
      w: 1,
      h: 1
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
              opacity: 0.8
            }
          ]
        }
      ],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });

    expect(chapter.pages[0].blocks[0].bbox).toEqual({ x: 999, y: 999, w: 1, h: 1 });
    expect(chapter.pages[0].blocks[0].renderBbox).toEqual({ x: 999, y: 999, w: 1, h: 1 });
    expect(chapter.pages[0].blocks[0].bboxSpace).toBe("normalized_1000");
    expect(chapter.pages[0].blocks[0].renderBboxSpace).toBe("normalized_1000");
  });

  it("uses renderBbox when a dedicated layout box exists", () => {
    expect(
      resolveBlockRenderBbox({
        bbox: { x: 100, y: 120, w: 180, h: 220 },
        renderBbox: { x: 80, y: 100, w: 240, h: 280 }
      })
    ).toEqual({ x: 80, y: 100, w: 240, h: 280 });
  });

  it("converts pixel-space boxes into normalized page coordinates", () => {
    expect(
      resolveBlockRenderBbox(
        {
          bbox: { x: 240, y: 360, w: 120, h: 180 },
          bboxSpace: "pixels"
        },
        { width: 1200, height: 1800 }
      )
    ).toEqual({ x: 200, y: 200, w: 100, h: 100 });
  });

  it("expands an effective render box for tiny source boxes without changing the source bbox", () => {
    const block = {
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      bboxSpace: "normalized_1000" as const,
      renderDirection: "horizontal" as const,
      lineHeight: 1.18,
      autoFitText: true
    };
    const effective = resolveEffectiveRenderBbox(block, { width: 1000, height: 1000 }, "가나다");

    expect(block.bbox).toEqual({ x: 100, y: 100, w: 4, h: 4 });
    expect(effective.w).toBeGreaterThan(block.bbox.w);
    expect(effective.h).toBeGreaterThan(block.bbox.h);
    expect(resolveEditableBlockBbox(block, { width: 1000, height: 1000 }, "가나다").key).toBe("renderBbox");
  });

  it("respects an explicit renderBbox as a manual layout box", () => {
    const block = {
      bbox: { x: 100, y: 100, w: 4, h: 4 },
      renderBbox: { x: 80, y: 90, w: 8, h: 8 },
      renderBboxSpace: "normalized_1000" as const,
      renderDirection: "horizontal" as const,
      lineHeight: 1.18
    };

    expect(resolveEffectiveRenderBbox(block, { width: 1000, height: 1000 }, "가나다라마바사")).toEqual(block.renderBbox);
  });

  it("estimates a larger font size for a larger render box", () => {
    const bboxOnly = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        bbox: { x: 100, y: 100, w: 80, h: 100 }
      },
      { width: 1000, height: 1600 }
    );
    const withRenderBbox = estimateBlockFontSizePx(
      "한국어 번역문",
      {
        bbox: { x: 100, y: 100, w: 80, h: 100 },
        renderBbox: { x: 80, y: 80, w: 240, h: 240 }
      },
      { width: 1000, height: 1600 }
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
        opacity: 0.8
      },
      { x: 120, y: 140, w: 240, h: 280 }
    );

    expect(next.bbox).toEqual({ x: 100, y: 100, w: 80, h: 120 });
    expect(next.renderBbox).toEqual({ x: 120, y: 140, w: 240, h: 280 });
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
      autoFitText: true
    };

    const next = applyEditableBlockBbox(block, { x: 120, y: 120, w: 80, h: 60 }, { width: 1000, height: 1000 }, block.translatedText);

    expect(next.bbox).toEqual(block.bbox);
    expect(next.renderBbox).toEqual({ x: 120, y: 120, w: 80, h: 60 });
  });

  it("offsets both source and render boxes when duplicating a block", () => {
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
        opacity: 0.8
      },
      16,
      16
    );

    expect(duplicated.bbox).toEqual({ x: 116, y: 116, w: 80, h: 120 });
    expect(duplicated.renderBbox).toEqual({ x: 96, y: 106, w: 220, h: 260 });
  });

  it("normalizes old block kinds into the unified inpainting block type and allows manual direction controls", () => {
    expect(normalizeBlockType("speech")).toBe("nonsolid");
    expect(normalizeBlockType("caption")).toBe("nonsolid");
    expect(normalizeBlockType("sfx")).toBe("nonsolid");
    expect(enforceRenderDirection("nonsolid", "vertical")).toBe("vertical");
    expect(normalizeRenderDirection("vertical", "horizontal")).toBe("vertical");
  });
});
