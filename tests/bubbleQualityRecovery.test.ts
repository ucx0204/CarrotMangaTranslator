import { describe, expect, it } from "vitest";
import {
  findBubbleRecoveryHints,
  mergeRecoveredBubbleMask,
} from "../src/main/inpainting/bubbleQualityRecovery";
import type { MangaPage } from "../src/shared/libraryTypes";

describe("conditional highest-quality bubble recovery", () => {
  it("selects only missing or undersized precise masks", () => {
    const page = createPage();
    const mask = new Uint8Array(page.width * page.height);
    fillMask(mask, page.width, 1, { x: 3, y: 3, w: 34, h: 34 });
    fillMask(mask, page.width, 2, { x: 49, y: 17, w: 9, h: 18 });

    const hints = findBubbleRecoveryHints(page, mask);

    expect(hints.map((hint) => hint.blockId)).toEqual(["weak", "missing"]);
  });

  it("replaces only recovered failed regions and keeps good masks intact", () => {
    const page = createPage();
    const base = new Uint8Array(page.width * page.height);
    fillMask(base, page.width, 1, { x: 3, y: 3, w: 34, h: 34 });
    fillMask(base, page.width, 2, { x: 49, y: 17, w: 9, h: 18 });
    const hints = findBubbleRecoveryHints(page, base);
    const recovered = new Uint8Array(base.length);
    fillMask(recovered, page.width, 1, { x: 42, y: 5, w: 34, h: 38 });
    fillMask(recovered, page.width, 2, { x: 79, y: 5, w: 19, h: 38 });

    const result = mergeRecoveredBubbleMask(base, recovered, page, hints);

    expect(result.recoveredBlocks).toBe(2);
    expect(result.mask[10 * page.width + 10]).toBe(1);
    expect(result.mask[20 * page.width + 50]).not.toBe(2);
    expect(result.mask[10 * page.width + 50]).toBeGreaterThan(2);
    expect(result.mask[10 * page.width + 90]).toBeGreaterThan(2);
  });

  it("ignores an empty recovery result", () => {
    const page = createPage();
    const base = new Uint8Array(page.width * page.height);
    const hints = findBubbleRecoveryHints(page, base);

    const result = mergeRecoveredBubbleMask(
      base,
      new Uint8Array(base.length),
      page,
      hints,
    );

    expect(result.recoveredBlocks).toBe(0);
    expect(result.mask).toEqual(base);
  });
});

function createPage(): MangaPage {
  return {
    id: "page",
    name: "page.png",
    imagePath: "page.png",
    dataUrl: "",
    width: 100,
    height: 50,
    blocks: [
      createBlock("good", 15),
      createBlock("weak", 50),
      createBlock("missing", 86),
    ],
    analysisStatus: "idle",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function createBlock(id: string, x: number): MangaPage["blocks"][number] {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y: 18, w: 8, h: 16 },
    bboxSpace: "pixels",
    sourceText: "text",
    translatedText: "번역",
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

function fillMask(
  mask: Uint8Array,
  width: number,
  id: number,
  rect: { x: number; y: number; w: number; h: number },
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    mask.fill(id, y * width + rect.x, y * width + rect.x + rect.w);
  }
}
