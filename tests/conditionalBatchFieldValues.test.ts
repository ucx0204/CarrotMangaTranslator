import { describe, expect, it } from "vitest";
import {
  readConditionalBatchField,
  type ConditionalBatchField,
  type ConditionalBatchFieldReadContext,
} from "../src/shared/conditionalBatchFieldRegistry";
import { evaluateConditionalBatchMatch } from "../src/shared/conditionalBatchEngine";
import { DEFAULT_BLOCK_FONT_ID } from "../src/shared/blockFontCatalog";
import { DEFAULT_TEXT_EFFECT } from "../src/shared/textEffect";
import { DEFAULT_TEXT_GLOW } from "../src/shared/textGlow";
import { resolveEffectiveTextOutlineWidthPx } from "../src/shared/textOutline";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const block: TranslationBlock = {
  id: "block",
  type: "nonsolid",
  bbox: { x: 100, y: 100, w: 400, h: 200 },
  sourceText: "原文",
  translatedText: "번역문",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "horizontal",
  fontSizePx: 25,
  lineHeight: 1.2,
  textAlign: "center",
  textColor: "#111111",
  backgroundColor: "#ffffff",
  opacity: 1,
};
const context: ConditionalBatchFieldReadContext = {
  page: { id: "page", width: 1000, height: 1600, blocks: [block] } as MangaPage,
  pageIndex: 0,
  blockIndex: 0,
};

describe("conditional batch effective field values", () => {
  it.each<[ConditionalBatchField, string | number]>([
    ["fontFamily", DEFAULT_BLOCK_FONT_ID],
    ["wordBreak", "break-all"],
    ["letterSpacing", 0],
    ["fontWidthScale", 1],
    ["rotationDeg", 0],
    ["textOpacity", 1],
    ["outlineWidthPx", resolveEffectiveTextOutlineWidthPx(block, 25)],
    ["outlineWidthScale", 1],
    ["outerOutlineWidthPx", 0],
    ["outlineColor", "#ffffff"],
    ["outerOutlineColor", "#111111"],
    ["textBackgroundColor", "#ffffff"],
    ["textEffectColor", DEFAULT_TEXT_EFFECT.color],
    ["textEffectOffsetX", DEFAULT_TEXT_EFFECT.offsetXpx],
    ["textEffectOffsetY", DEFAULT_TEXT_EFFECT.offsetYpx],
    ["textEffectBlur", DEFAULT_TEXT_EFFECT.blurPx],
    ["textEffectOpacity", DEFAULT_TEXT_EFFECT.opacity],
    ["textGlowColor", DEFAULT_TEXT_GLOW.color],
    ["textGlowBlur", DEFAULT_TEXT_GLOW.blurPx],
    ["textGlowOpacity", DEFAULT_TEXT_GLOW.opacity],
  ])(
    "matches an omitted %s against its actual editor default",
    (field, value) => {
      expect(
        evaluateConditionalBatchMatch(
          block,
          {
            mode: "all",
            groups: [],
            conditions: [
              { id: field, enabled: true, field, operator: "equals", value },
            ],
          },
          context,
        ).matched,
      ).toBe(true);
      expect(readConditionalBatchField(block, field, context)).toBe(value);
    },
  );

  it("keeps genuinely unavailable analysis and review metadata absent", () => {
    for (const field of [
      "fontRoleConfidence",
      "fontRole",
      "reviewStatus",
      "speakerId",
    ] as const) {
      expect(readConditionalBatchField(block, field, context)).toBeUndefined();
    }
  });

  it("uses rendered font size for an automatic outline and preserves an explicit width", () => {
    const resolvedContext = { ...context, resolveFontSizePx: () => 13 };
    const automatic = { ...block, outlineWidthScale: 2 };
    expect(
      readConditionalBatchField(automatic, "outlineWidthPx", resolvedContext),
    ).toBe(resolveEffectiveTextOutlineWidthPx(automatic, 13));
    expect(
      readConditionalBatchField(
        { ...automatic, outlineWidthPx: 0 },
        "outlineWidthPx",
        resolvedContext,
      ),
    ).toBe(0);
  });

  it("uses the direction-specific legacy wrapping policy", () => {
    expect(
      readConditionalBatchField(
        { ...block, renderDirection: "vertical" },
        "wordBreak",
        context,
      ),
    ).toBe("break-word");
    expect(
      readConditionalBatchField(
        { ...block, wordBreak: "keep-all" },
        "wordBreak",
        context,
      ),
    ).toBe("keep-all");
  });

  it("compares the same physical rectangle identically in pixels and normalized coordinates", () => {
    const pixels = {
      ...block,
      bboxSpace: "pixels" as const,
      bbox: { x: 100, y: 160, w: 400, h: 320 },
    };
    for (const field of [
      "bboxWidth",
      "bboxHeight",
      "bboxAspectRatio",
    ] as const) {
      expect(readConditionalBatchField(pixels, field, context)).toBe(
        readConditionalBatchField(block, field, context),
      );
    }
    expect(readConditionalBatchField(block, "bboxAspectRatio", context)).toBe(
      1.25,
    );
    expect(
      readConditionalBatchField(
        { ...block, bbox: { ...block.bbox, h: 0 } },
        "bboxAspectRatio",
        context,
      ),
    ).toBe(0);
  });
});
