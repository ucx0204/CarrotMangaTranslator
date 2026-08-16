import { describe, expect, it } from "vitest";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("outlineWidthPx schema", () => {
  it("accepts only an in-range optional pixel outline width", () => {
    const block = makeBlock();
    expect(TranslationBlockSchema.safeParse(block).success).toBe(true);
    for (const outlineWidthPx of [0, 0.5, 8, 64]) {
      const parsed = TranslationBlockSchema.parse({ ...block, outlineWidthPx });
      expect(parsed.outlineWidthPx).toBe(outlineWidthPx);
    }
    for (const outlineWidthPx of [-0.5, 64.5, Number.NaN]) {
      expect(
        TranslationBlockSchema.safeParse({ ...block, outlineWidthPx }).success,
      ).toBe(false);
    }
  });

  it("drops the removed automatic rollback payload while preserving its rendered contrast", () => {
    const parsed = TranslationBlockSchema.parse({
      ...makeBlock(),
      textColor: "#f7f7f2",
      outlineColor: "#f7f7f2",
      outlineWidthScale: 1,
      automaticFontMatch: {
        schemaVersion: 1,
        selectedFontId: "dohyeon",
        role: "dialogue",
        confidence: 0.9,
        source: "local_visual",
        previousStyle: {
          fontFamily: null,
          bold: null,
          italic: null,
          outlineWidthScale: 1,
        },
      },
    });

    expect(parsed).not.toHaveProperty("automaticFontMatch");
    expect(parsed.outlineColor).toBe("#111111");
  });
});

function makeBlock(): TranslationBlock {
  return {
    id: "outline-schema-block",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 120 },
    sourceText: "原文",
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
}
