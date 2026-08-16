import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCK_FORMAT_DEFAULTS,
  applyFormatDefaultsToBlock,
} from "../src/shared/blockFormat";
import {
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("absolute outline width persistence", () => {
  it("round-trips the optional pixel field without rewriting legacy defaults", () => {
    const defaults = resolveDefaultAppSettings();
    const legacy = parseStoredAppSettings(
      JSON.stringify({
        ...defaults,
        blockFormatDefaults: {
          ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
          outlineWidthScale: 1.7,
        },
      }),
      defaults,
    );
    expect(legacy.blockFormatDefaults?.outlineWidthPx).toBeUndefined();
    expect(legacy.blockFormatDefaults?.outlineWidthScale).toBe(1.7);

    const restored = parseStoredAppSettings(
      JSON.stringify({
        ...defaults,
        blockFormatDefaults: {
          ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
          outlineWidthPx: 8.5,
          outlineWidthScale: 1.7,
        },
      }),
      defaults,
    );
    expect(restored.blockFormatDefaults?.outlineWidthPx).toBe(8.5);
    expect(restored.blockFormatDefaults?.outlineWidthScale).toBe(1.7);
  });

  it("applies only the selected representation to a block", () => {
    const legacyApplied = applyFormatDefaultsToBlock(makeBlock(), {
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      outlineEnabled: true,
      outlineWidthScale: 1.7,
    });
    expect(legacyApplied.outlineWidthPx).toBeUndefined();
    expect(legacyApplied.outlineWidthScale).toBe(1.7);

    const pixelApplied = applyFormatDefaultsToBlock(makeBlock(), {
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      outlineEnabled: true,
      outlineWidthPx: 8.5,
      outlineWidthScale: 1.7,
    });
    expect(pixelApplied.outlineWidthPx).toBe(8.5);
  });
});

function makeBlock(): TranslationBlock {
  return {
    id: "block-outline-persistence",
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    outlineWidthPx: 4,
    outlineWidthScale: 2,
  };
}
