import { describe, expect, it } from "vitest";
import type { TextStylePatch } from "../src/shared/richTextMarkup";
import type { TranslationBlock } from "../src/shared/textTypes";
import { applyRichTranslationCodeStyle } from "../src/renderer/src/components/richTranslationCodeFormatting";
import {
  normalizeRichTextOpacity,
  resolveRichTranslationCodeSelection,
  resolveRichTranslationSelectionValues,
} from "../src/renderer/src/components/richTranslationSelectionModel";

describe("rich translation editor model", () => {
  it.each<[TextStylePatch, string]>([
    [{ bold: true }, "**효과**"],
    [{ italic: true }, "*효과*"],
    [{ underline: true }, "[underline]효과[/underline]"],
    [{ strikethrough: true }, "[strike]효과[/strike]"],
    [{ emphasisMark: true }, "[emphasis]효과[/emphasis]"],
    [{ sizePx: 36 }, "[size=36]효과[/size]"],
    [{ fontFamily: "nanum-gothic" }, "[font=nanum-gothic]효과[/font]"],
    [{ opacity: 0.7 }, "[opacity=70]효과[/opacity]"],
    [{ widthScale: 1.25 }, "[width=1.25]효과[/width]"],
    [{ color: "#123456" }, "[color=#123456]효과[/color]"],
    [{ backgroundColor: "#ffeeaa" }, "[background=#ffeeaa]효과[/background]"],
    [
      { outlineColor: "#abcdef" },
      "[outline-color=#abcdef]효과[/outline-color]",
    ],
    [{ outlineWidthPx: 2.5 }, "[outline-width=2.5]효과[/outline-width]"],
    [
      { outerOutlineColor: "#010203" },
      "[outer-outline-color=#010203]효과[/outer-outline-color]",
    ],
    [
      { outerOutlineWidthPx: 4 },
      "[outer-outline-width=4]효과[/outer-outline-width]",
    ],
    [{ glowColor: "#ff5500" }, "[glow-color=#ff5500]효과[/glow-color]"],
    [{ glowBlurPx: 9 }, "[glow-blur=9]효과[/glow-blur]"],
    [{ glowOpacity: 0.55 }, "[glow-opacity=0.55]효과[/glow-opacity]"],
  ])(
    "maps a code-mode patch to its safe markup contract",
    (patch, expected) => {
      expect(
        applyRichTranslationCodeStyle("효과", { start: 0, end: 2 }, patch)
          ?.value,
      ).toBe(expected);
    },
  );

  it("preserves the historical first-field priority for a compound patch", () => {
    expect(
      applyRichTranslationCodeStyle(
        "효과",
        { start: 0, end: 2 },
        { bold: true, color: "#123456" },
      )?.value,
    ).toBe("**효과**");
  });

  it("removes a nullable code-mode style without changing the text", () => {
    const value = "[background=#ffeeaa]효과[/background]";
    const start = value.indexOf("효과");
    expect(
      applyRichTranslationCodeStyle(
        value,
        { start, end: start + 2 },
        { backgroundColor: null },
      )?.value,
    ).toBe("효과");
  });

  it("maps raw markup selections back to visible character offsets", () => {
    const value = "가[size=48]나다[/size]라";
    const start = value.indexOf("나다");
    expect(
      resolveRichTranslationCodeSelection(value, { start, end: start + 2 }, 4),
    ).toEqual({ start: 1, end: 3 });
  });

  it("reports mixed selection values and overlays caret-only typing style", () => {
    const block = makeBlock();
    const mixed = resolveRichTranslationSelectionValues(
      [
        { text: "가", bold: false, italic: false, sizePx: 24 },
        { text: "나", bold: true, italic: false, sizePx: 40 },
      ],
      { start: 0, end: 2 },
      block,
      null,
      null,
    );
    expect(mixed.sizeMixed).toBe(true);
    expect(mixed.bold).toBe(false);

    const typing = resolveRichTranslationSelectionValues(
      [],
      { start: 0, end: 0 },
      block,
      null,
      { sizePx: 48, opacity: 0.6, backgroundColor: "#ffeeaa" },
    );
    expect(typing).toMatchObject({
      sizePx: 48,
      sizeMixed: false,
      opacityPercent: 60,
      backgroundEnabled: true,
      backgroundColor: "#ffeeaa",
    });
  });

  it("normalizes missing, non-finite, and out-of-range opacity", () => {
    expect(normalizeRichTextOpacity(undefined)).toBe(1);
    expect(normalizeRichTextOpacity(Number.NaN)).toBe(1);
    expect(normalizeRichTextOpacity(-1)).toBe(0);
    expect(normalizeRichTextOpacity(2)).toBe(1);
  });
});

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#fffdf5",
    opacity: 1,
    autoFitText: false,
  };
}
