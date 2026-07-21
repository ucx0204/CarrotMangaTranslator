import { describe, expect, it } from "vitest";
import { buildPageExportBlocks } from "../src/main/pageExportBlocks";
import {
  mapPointWithMatrix3d,
  type CssMatrix3d,
} from "../src/shared/blockTransforms";
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

describe("buildPageExportBlocks line breaking", () => {
  it("preserves legacy wrapping by render direction", () => {
    const [legacyHorizontal] = buildPageExportBlocks(
      makePage(makeBlock({ wordBreak: undefined })),
      1000,
      1000,
      new Map(),
    );
    const [legacyVertical] = buildPageExportBlocks(
      makePage(
        makeBlock({ renderDirection: "vertical", wordBreak: undefined }),
      ),
      1000,
      1000,
      new Map(),
    );

    expect(legacyHorizontal.wordBreak).toBe("break-all");
    expect(legacyVertical.wordBreak).toBe("break-word");
  });

  it("preserves every explicitly selected mode", () => {
    for (const wordBreak of [
      "normal",
      "break-all",
      "keep-all",
      "break-word",
    ] as const) {
      const [exported] = buildPageExportBlocks(
        makePage(makeBlock({ wordBreak })),
        1000,
        1000,
        new Map(),
      );
      expect(exported.wordBreak).toBe(wordBreak);
    }
  });
});

describe("buildPageExportBlocks transforms", () => {
  it("exports the full rotation range with the shared canonical angle", () => {
    const [positive] = buildPageExportBlocks(
      makePage(makeBlock({ rotationDeg: 135.4 })),
      1000,
      1000,
      new Map(),
    );
    const [wrapped] = buildPageExportBlocks(
      makePage(makeBlock({ rotationDeg: 271 })),
      1000,
      1000,
      new Map(),
    );

    expect(positive.rotationDeg).toBe(135.4);
    expect(wrapped.rotationDeg).toBe(-89);
  });

  it("omits transform payloads for a legacy block", () => {
    const [exported] = buildPageExportBlocks(
      makePage(makeBlock({ rotationDeg: undefined })),
      1000,
      1000,
      new Map(),
    );

    expect(exported.rotationDeg).toBe(0);
    expect(exported).not.toHaveProperty("perspectiveMatrix3d");
    expect(exported).not.toHaveProperty("curveLayout");
  });

  it("serializes a local perspective quad into the output-sized homography", () => {
    const corners = [
      { x: 0.2, y: 0 },
      { x: 0.8, y: 0.1 },
      { x: 1, y: 1 },
      { x: 0, y: 0.9 },
    ] as const;
    const [exported] = buildPageExportBlocks(
      makePage(
        makeBlock({
          perspectiveTransform: { version: 1, corners: [...corners] },
        }),
      ),
      1000,
      1000,
      new Map(),
    );

    const matrix = parseCssMatrix3d(exported.perspectiveMatrix3d);
    expect(mapPointWithMatrix3d({ x: 0, y: 0 }, matrix)).toEqual({
      x: 100,
      y: 0,
    });
    expectPointClose(
      mapPointWithMatrix3d(
        { x: exported.rect.width, y: exported.rect.height },
        matrix,
      ),
      { x: 500, y: 500 },
      0,
    );
  });

  it("normalizes an unsafe saved perspective to identity like the editor", () => {
    const [exported] = buildPageExportBlocks(
      makePage(
        makeBlock({
          perspectiveTransform: {
            version: 1,
            corners: [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
              { x: 1, y: 0 },
            ],
          },
        }),
      ),
      1000,
      1000,
      new Map(),
    );

    const matrix = parseCssMatrix3d(exported.perspectiveMatrix3d);
    expect(mapPointWithMatrix3d({ x: 0, y: 0 }, matrix)).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      mapPointWithMatrix3d(
        { x: exported.rect.width, y: exported.rect.height },
        matrix,
      ),
    ).toEqual({ x: exported.rect.width, y: exported.rect.height });
  });

  it("exports a reversed curve as a 96-segment local-pixel arc table", () => {
    const [exported] = buildPageExportBlocks(
      makePage(
        makeBlock({
          curveLayout: {
            version: 1,
            path: {
              type: "quadratic",
              start: { x: 0.1, y: 0.5 },
              control: { x: 0.5, y: -0.2 },
              end: { x: 0.9, y: 0.5 },
            },
            alignment: "end",
            offsetEm: 0.75,
            orientation: "upright",
            reversed: true,
            fitSpacing: true,
          },
        }),
      ),
      1000,
      1000,
      new Map(),
    );

    const curve = exported.curveLayout;
    expect(curve).toMatchObject({
      alignment: "end",
      offsetEm: 0.75,
      orientation: "upright",
      fitSpacing: true,
    });
    expect(curve?.samples).toHaveLength(97);
    expectPointClose(curve?.samples[0], { x: 450, y: 250 });
    expectPointClose(curve?.samples.at(-1), { x: 50, y: 250 });
    expect(curve?.pathLength).toBeGreaterThan(400);
    expect(curve?.samples[0].tangentX).toBeLessThan(0);
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

function parseCssMatrix3d(value: string | undefined): CssMatrix3d {
  expect(value).toMatch(/^matrix3d\(.+\)$/);
  const values = String(value)
    .slice("matrix3d(".length, -1)
    .split(",")
    .map((entry) => Number(entry.trim()));
  expect(values).toHaveLength(16);
  expect(values.every(Number.isFinite)).toBe(true);
  return values as CssMatrix3d;
}

function expectPointClose(
  actual: { x: number; y: number } | undefined,
  expected: { x: number; y: number },
  precision = 5,
): void {
  expect(actual?.x).toBeCloseTo(expected.x, precision);
  expect(actual?.y).toBeCloseTo(expected.y, precision);
}
