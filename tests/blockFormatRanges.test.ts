import { describe, expect, it } from "vitest";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("expanded block typography ranges", () => {
  it("accepts both boundary sets in persisted translation blocks", () => {
    for (const values of [
      {
        fontSizePx: 1,
        lineHeight: 0.1,
        letterSpacing: -1,
        fontWidthScale: 0.1,
      },
      {
        fontSizePx: 512,
        lineHeight: 10,
        letterSpacing: 5,
        fontWidthScale: 5,
      },
    ]) {
      expect(
        TranslationBlockSchema.safeParse({ ...BLOCK, ...values }).success,
      ).toBe(true);
    }
  });

  it("rejects values beyond the expanded safety bounds", () => {
    for (const values of [
      { fontSizePx: 512.5 },
      { lineHeight: 10.01 },
      { letterSpacing: -1.01 },
      { fontWidthScale: 5.01 },
    ]) {
      expect(
        TranslationBlockSchema.safeParse({ ...BLOCK, ...values }).success,
      ).toBe(false);
    }
  });

  it("keeps the optional source glyph face inside the font-size safety bounds", () => {
    expect(
      TranslationBlockSchema.safeParse({
        ...BLOCK,
        sourceFontFacePx: 24.5,
        sourceFontSizeConfidence: 0.9,
        sourceFontSizeMethod: "raster-core-v1",
      }).success,
    ).toBe(true);
    expect(
      TranslationBlockSchema.safeParse({
        ...BLOCK,
        sourceFontFacePx: 0.5,
      }).success,
    ).toBe(false);
    expect(
      TranslationBlockSchema.safeParse({
        ...BLOCK,
        sourceFontFacePx: 512.5,
      }).success,
    ).toBe(false);
  });
});

const BLOCK: TranslationBlock = {
  id: "block",
  type: "nonsolid",
  bbox: { x: 100, y: 100, w: 200, h: 200 },
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
};
