import { describe, expect, it } from "vitest";
import { buildPageExportBlocks } from "../src/main/pageExportBlocks";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

function makeBlock(overrides: Partial<TranslationBlock>): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 500, h: 500 },
    sourceText: "source",
    translatedText: "안녕하세요",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...overrides,
  };
}

function makePage(block: TranslationBlock): MangaPage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [block],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildPageExportBlocks lineHeight parity", () => {
  it("preserves the editor's tight line-height range instead of clamping to 1", () => {
    for (const lineHeight of [0.8, 0.99, 1.18, 1.8, 3]) {
      const [exported] = buildPageExportBlocks(
        makePage(makeBlock({ lineHeight })),
        1000,
        1000,
        new Map(),
      );
      expect(exported.lineHeight).toBe(lineHeight);
    }
  });

  it("clamps out-of-range line-height to the supported 0.8–3 window", () => {
    const [tooSmall] = buildPageExportBlocks(
      makePage(makeBlock({ lineHeight: 0.2 })),
      1000,
      1000,
      new Map(),
    );
    const [tooLarge] = buildPageExportBlocks(
      makePage(makeBlock({ lineHeight: 9 })),
      1000,
      1000,
      new Map(),
    );
    expect(tooSmall.lineHeight).toBe(0.8);
    expect(tooLarge.lineHeight).toBe(3);
  });
});
