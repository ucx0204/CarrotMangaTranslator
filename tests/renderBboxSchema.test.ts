import { describe, expect, it } from "vitest";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";

describe("render bbox schema", () => {
  it("accepts a partially off-page render box while source geometry stays bounded", () => {
    const parsed = TranslationBlockSchema.parse({
      ...makeBlock(),
      bbox: { x: 0, y: 100, w: 120, h: 160 },
      renderBbox: { x: -112, y: 100, w: 120, h: 160 },
      renderBboxSpace: "normalized_1000",
    });

    expect(parsed.bbox).toEqual({ x: 0, y: 100, w: 120, h: 160 });
    expect(parsed.renderBbox).toEqual({ x: -112, y: 100, w: 120, h: 160 });
  });

  it("rejects render boxes outside the extended safety range", () => {
    for (const renderBbox of [
      { x: -4001, y: 100, w: 120, h: 160 },
      { x: 100, y: 100, w: 4001, h: 160 },
    ]) {
      expect(
        TranslationBlockSchema.safeParse({
          ...makeBlock(),
          renderBbox,
          renderBboxSpace: "normalized_1000",
        }).success,
      ).toBe(false);
    }
  });

  it("continues to reject off-page source geometry", () => {
    expect(
      TranslationBlockSchema.safeParse({
        ...makeBlock(),
        bbox: { x: -1, y: 100, w: 120, h: 160 },
      }).success,
    ).toBe(false);
  });
});

function makeBlock() {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 120, h: 160 },
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
