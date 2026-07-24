import { describe, expect, it, vi } from "vitest";
import {
  createBlockFontLoadKey,
  loadBlockFonts,
} from "../src/renderer/src/lib/blockFontLoading";
import {
  createBlockFontCatalog,
  DEFAULT_BLOCK_FONT_CATALOG,
} from "../src/renderer/src/lib/fonts";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("block font loading", () => {
  it("reports a bundled font that has no declared FontFace", async () => {
    const fonts = makeFontSet(() => Promise.resolve([]));
    const report = await loadBlockFonts(
      { fonts },
      [makeBlock({ fontFamily: "nanum-myeongjo" })],
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    expect(report.failures).toEqual([]);
    expect(report.missingFamilies).toContain(
      '"MGT Nanum Myeongjo", "Malgun Gothic", serif',
    );
  });

  it("requires registered custom fonts but permits an OS default stack", async () => {
    const customCatalog = createBlockFontCatalog(
      [
        {
          id: "custom-font",
          label: "Custom",
          family: "MGTUser-Custom",
          fileName: "custom.ttf",
        },
      ],
      { defaultFontId: "custom-font", favoriteIds: [], orderedIds: [] },
    );
    const fonts = makeFontSet(() => Promise.resolve([]));

    const custom = await loadBlockFonts(
      { fonts },
      [makeBlock({ fontFamily: undefined })],
      customCatalog,
    );
    const system = await loadBlockFonts(
      { fonts },
      [makeBlock({ fontFamily: undefined })],
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    expect(custom.missingFamilies).toContain(
      '"MGTUser-Custom", "Malgun Gothic", sans-serif',
    );
    expect(system.missingFamilies).toEqual([]);
  });

  it("keeps the load key stable across text edits until font style changes", () => {
    const original = makeBlock({ translatedText: "첫 문장" });
    const edited = makeBlock({ translatedText: "완전히 다른 문장" });
    const bold = makeBlock({ translatedText: "**굵은 문장**" });

    expect(createBlockFontLoadKey([original], DEFAULT_BLOCK_FONT_CATALOG)).toBe(
      createBlockFontLoadKey([edited], DEFAULT_BLOCK_FONT_CATALOG),
    );
    expect(createBlockFontLoadKey([bold], DEFAULT_BLOCK_FONT_CATALOG)).not.toBe(
      createBlockFontLoadKey([original], DEFAULT_BLOCK_FONT_CATALOG),
    );
  });
});

function makeFontSet(
  load: (css: string, text?: string) => Promise<FontFace[]>,
): {
  load: (css: string, text?: string) => Promise<FontFace[]>;
  ready: Promise<void>;
} {
  return {
    load: vi.fn(load),
    ready: Promise.resolve(undefined),
  };
}

function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    backgroundColor: "#ffffff",
    bbox: { x: 0, y: 0, w: 1000, h: 1000 },
    confidence: 1,
    fontSizePx: 24,
    id: "block",
    lineHeight: 1.2,
    opacity: 1,
    renderDirection: "horizontal",
    sourceDirection: "horizontal",
    sourceText: "",
    textAlign: "center",
    textColor: "#111111",
    translatedText: "텍스트",
    type: "nonsolid",
    ...overrides,
  };
}
