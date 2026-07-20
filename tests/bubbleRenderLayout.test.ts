import { describe, expect, it } from "vitest";
import { bboxToPixels } from "../src/shared/geometry";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { BBox, TranslationBlock } from "../src/shared/textTypes";
import {
  applyBubbleRenderLayouts,
  resolveAutomaticRenderBbox,
} from "../src/main/inpainting/bubbleRenderLayout";

describe("bubble-aware translation layout", () => {
  it("expands a narrow vertical source block into a wide horizontal bubble area", () => {
    const page = createPage([
      createBlock("vertical-source", { x: 45, y: 28, w: 10, h: 40 }),
    ]);
    const mask = createMask(page.width, page.height, [
      { id: 1, x: 8, y: 10, w: 84, h: 72 },
    ]);

    const result = applyBubbleRenderLayouts(page, mask);
    const block = result.blocks[0];
    expect(block.renderBbox).toBeDefined();
    if (!block.renderBbox) throw new Error("render bbox was not generated");
    const renderPixels = bboxToPixels(
      block.renderBbox,
      page.width,
      page.height,
    );

    expect(result.expandedBlocks).toBe(1);
    expect(block.bbox).toEqual(page.blocks[0].bbox);
    expect(block.renderBboxSpace).toBe("normalized_1000");
    expect(block.autoFitText).toBe(true);
    expect(renderPixels.w).toBeGreaterThan(70);
    expect(renderPixels.w).toBeGreaterThan(renderPixels.h);
    expect(renderPixels.x).toBeGreaterThanOrEqual(10);
    expect(renderPixels.x + renderPixels.w).toBeLessThanOrEqual(90);
  });

  it("preserves a manually adjusted render box", () => {
    const manual = { x: 100, y: 200, w: 500, h: 250 };
    const page = createPage([
      {
        ...createBlock("manual", { x: 45, y: 28, w: 10, h: 40 }),
        renderBbox: manual,
        renderBboxSpace: "normalized_1000",
      },
    ]);
    const mask = createMask(page.width, page.height, [
      { id: 1, x: 8, y: 10, w: 84, h: 72 },
    ]);

    const result = applyBubbleRenderLayouts(page, mask);

    expect(result.expandedBlocks).toBe(0);
    expect(result.blocks[0]).toBe(page.blocks[0]);
    expect(result.blocks[0].renderBbox).toEqual(manual);
  });

  it("keeps adjacent split-bubble layouts inside their assigned regions", () => {
    const page = createPage([
      {
        ...createBlock("left", { x: 22, y: 30, w: 8, h: 32 }),
        fontSizePx: 10,
      },
      {
        ...createBlock("right", { x: 70, y: 30, w: 8, h: 32 }),
        fontSizePx: 10,
      },
    ]);
    const mask = createMask(page.width, page.height, [
      { id: 1, x: 4, y: 12, w: 44, h: 68 },
      { id: 2, x: 52, y: 12, w: 44, h: 68 },
    ]);

    const result = applyBubbleRenderLayouts(page, mask);
    const renderBoxes = result.blocks.map((block) => block.renderBbox);
    expect(renderBoxes.every(Boolean)).toBe(true);
    if (!renderBoxes[0] || !renderBoxes[1]) {
      throw new Error("split bubble render boxes were not generated");
    }
    const left = bboxToPixels(renderBoxes[0], page.width, page.height);
    const right = bboxToPixels(renderBoxes[1], page.width, page.height);

    expect(result.expandedBlocks).toBe(2);
    expect(left.x + left.w).toBeLessThan(right.x);
    expect(left.x).toBeGreaterThanOrEqual(6);
    expect(right.x + right.w).toBeLessThanOrEqual(94);
  });

  it("does not create a render box without translated horizontal text", () => {
    const mask = createMask(100, 100, [{ id: 1, x: 8, y: 10, w: 84, h: 72 }]);
    const emptyText = createBlock("empty", { x: 45, y: 28, w: 10, h: 40 });
    emptyText.translatedText = "";
    const vertical = {
      ...createBlock("vertical", { x: 45, y: 28, w: 10, h: 40 }),
      renderDirection: "vertical" as const,
    };

    expect(
      resolveAutomaticRenderBbox(createPage([emptyText]), emptyText, mask),
    ).toBeNull();
    expect(
      resolveAutomaticRenderBbox(createPage([vertical]), vertical, mask),
    ).toBeNull();
  });
});

function createPage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function createBlock(id: string, bbox: BBox): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox,
    bboxSpace: "pixels",
    sourceText: "縦書き",
    translatedText: "가로로 자연스럽게 번역된 문장",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 12,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function createMask(
  width: number,
  height: number,
  regions: Array<{
    id: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    for (let y = region.y; y < region.y + region.h; y += 1) {
      mask.fill(
        region.id,
        y * width + region.x,
        y * width + region.x + region.w,
      );
    }
  }
  return mask;
}
