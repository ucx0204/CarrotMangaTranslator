import { describe, expect, it } from "vitest";
import { buildPageExportBlocks } from "../src/main/pageExportBlocks";
import {
  BUILT_IN_BLOCK_FONTS,
  DEFAULT_BLOCK_FONT_STACK,
} from "../src/shared/blockFontCatalog";
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

  it("scales font size with the same floor rule as the editor layout", () => {
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ fontSizePx: 25, autoFitText: false })),
      500,
      500,
      new Map(),
    );

    expect(exported.fontSizePx).toBe(12);
  });
});

describe("buildPageExportBlocks text opacity", () => {
  it("exports text opacity independently from the editor block background", () => {
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ textOpacity: 0.42, opacity: 0.15 })),
      1000,
      1000,
      new Map(),
    );

    expect(exported.textOpacity).toBe(0.42);
    expect(exported).not.toHaveProperty("opacity");
  });

  it("defaults legacy blocks to opaque text and clamps invalid values", () => {
    const [legacy] = buildPageExportBlocks(
      makePage(makeBlock({ textOpacity: undefined })),
      1000,
      1000,
      new Map(),
    );
    const [clamped] = buildPageExportBlocks(
      makePage(makeBlock({ textOpacity: 4 })),
      1000,
      1000,
      new Map(),
    );

    expect(legacy.textOpacity).toBe(1);
    expect(clamped.textOpacity).toBe(1);
  });
});

describe("buildPageExportBlocks font family parity", () => {
  it.each(BUILT_IN_BLOCK_FONTS)("uses the shared family for $id", (font) => {
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ fontFamily: font.id })),
      1000,
      1000,
      new Map(),
    );
    expect(exported.fontFamily).toBe(font.cssFamily);
  });

  it("uses the default stack for an unknown font", () => {
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ fontFamily: "unknown-font" })),
      1000,
      1000,
      new Map(),
    );
    expect(exported.fontFamily).toBe(DEFAULT_BLOCK_FONT_STACK);
  });

  it("keeps a registered custom family ahead of built-in resolution", () => {
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ fontFamily: "custom-font" })),
      1000,
      1000,
      new Map([["custom-font", "MGTUser-custom"]]),
    );
    expect(exported.fontFamily).toBe(
      '"MGTUser-custom", "Malgun Gothic", sans-serif',
    );
  });

  it("uses the designated built-in font for inherited blocks", () => {
    const defaultFont = BUILT_IN_BLOCK_FONTS.find(
      (font) => font.id === "comic-neue",
    );
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ fontFamily: undefined })),
      1000,
      1000,
      new Map(),
      "comic-neue",
    );
    expect(exported.fontFamily).toBe(defaultFont?.cssFamily);
  });

  it("uses a designated custom font for inherited blocks while preserving explicit overrides", () => {
    const customFamilies = new Map([["custom-font", "MGTUser-custom"]]);
    const [inherited] = buildPageExportBlocks(
      makePage(makeBlock({ fontFamily: undefined })),
      1000,
      1000,
      customFamilies,
      "custom-font",
    );
    const explicit = BUILT_IN_BLOCK_FONTS.find(
      (font) => font.id === "nanum-gothic",
    );
    const [overridden] = buildPageExportBlocks(
      makePage(makeBlock({ fontFamily: "nanum-gothic" })),
      1000,
      1000,
      customFamilies,
      "custom-font",
    );

    expect(inherited.fontFamily).toBe(
      '"MGTUser-custom", "Malgun Gothic", sans-serif',
    );
    expect(overridden.fontFamily).toBe(explicit?.cssFamily);
  });
});
