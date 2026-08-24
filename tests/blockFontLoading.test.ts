import { describe, expect, it, vi } from "vitest";
import {
  areBlockFontsReadyForKey,
  clearBlockFontLoadCache,
  createBlockFontLoadKey,
  loadBlockFonts,
  loadBlockFontsForKey,
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

  it("loads every font referenced by an inline font run", () => {
    const key = createBlockFontLoadKey(
      [
        makeBlock({
          fontFamily: "nanum-gothic",
          translatedText: "기본 [font=nanum-myeongjo]명조[/font]",
        }),
      ],
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    expect(key).toContain("MGT Nanum Gothic");
    expect(key).toContain("MGT Nanum Myeongjo");
  });

  it("deduplicates an in-flight face request and exposes synchronous readiness", async () => {
    let resolveLoad: (faces: FontFace[]) => void = () => undefined;
    const fonts = makeFontSet(
      () =>
        new Promise<FontFace[]>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const target = { fonts };
    const loadKey = createBlockFontLoadKey(
      [makeBlock({ fontFamily: "nanum-myeongjo" })],
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    expect(areBlockFontsReadyForKey(target, loadKey)).toBe(false);
    const first = loadBlockFontsForKey(target, loadKey);
    const second = loadBlockFontsForKey(target, loadKey);
    await Promise.resolve();
    expect(fonts.load).toHaveBeenCalledTimes(1);

    resolveLoad([{} as FontFace]);
    await Promise.all([first, second]);
    expect(areBlockFontsReadyForKey(target, loadKey)).toBe(true);
    await loadBlockFontsForKey(target, loadKey);
    expect(fonts.load).toHaveBeenCalledTimes(1);
  });

  it("waits only for requested faces instead of the global FontFaceSet", async () => {
    const fonts = makeFontSet(() => Promise.resolve([{} as FontFace]));
    Object.defineProperty(fonts, "ready", {
      configurable: true,
      get: () => {
        throw new Error("global readiness must not be read");
      },
    });

    await expect(
      loadBlockFonts(
        { fonts },
        [makeBlock({ fontFamily: "nanum-myeongjo" })],
        DEFAULT_BLOCK_FONT_CATALOG,
      ),
    ).resolves.toMatchObject({ failures: [] });
  });

  it("reports a transient face failure, evicts it, and retries", async () => {
    const failure = new Error("temporary font failure");
    let attempts = 0;
    const fonts = makeFontSet(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(failure)
        : Promise.resolve([{} as FontFace]);
    });
    const target = { fonts };
    const loadKey = createBlockFontLoadKey(
      [makeBlock({ fontFamily: "nanum-myeongjo" })],
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    await expect(loadBlockFontsForKey(target, loadKey)).resolves.toMatchObject({
      failures: [{ error: failure }],
    });
    expect(areBlockFontsReadyForKey(target, loadKey)).toBe(false);
    await expect(loadBlockFontsForKey(target, loadKey)).resolves.toMatchObject({
      failures: [],
    });
    expect(fonts.load).toHaveBeenCalledTimes(2);
    expect(areBlockFontsReadyForKey(target, loadKey)).toBe(true);

    clearBlockFontLoadCache(target);
    expect(areBlockFontsReadyForKey(target, loadKey)).toBe(false);
  });

  it("accepts an empty key and rejects every malformed request shape", async () => {
    const target = {
      fonts: makeFontSet(() => Promise.resolve([{} as FontFace])),
    };
    expect(areBlockFontsReadyForKey(target, "")).toBe(true);
    await expect(loadBlockFontsForKey(target, "")).resolves.toEqual({
      failures: [],
      missingFamilies: [],
    });

    const invalidKeys = [
      "{}",
      "[null]",
      "[1]",
      '[{"family":"Family","required":true}]',
      '[{"css":1,"family":"Family","required":true}]',
      '[{"css":"16px Family","required":true}]',
      '[{"css":"16px Family","family":1,"required":true}]',
      '[{"css":"16px Family","family":"Family"}]',
      '[{"css":"16px Family","family":"Family","required":1}]',
    ];
    for (const invalidKey of invalidKeys) {
      await expect(loadBlockFontsForKey(target, invalidKey)).rejects.toThrow(
        "Invalid block font load key.",
      );
    }
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
