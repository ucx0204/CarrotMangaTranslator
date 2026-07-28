import { describe, expect, it } from "vitest";
import {
  applyNaturalTextLayout,
  segmentNaturalTextGraphemes,
} from "../src/shared/naturalTextLayout";
import { resolveNaturalShapeSlotPlans } from "../src/shared/naturalTextLayoutShape";
import { countSemanticNaturalGraphemes } from "../src/shared/naturalTextLayoutSegmentation";
import type { BubbleLayout } from "../src/shared/bubbleLayout";
import type { TranslationBlock } from "../src/shared/textTypes";

const PAGE_SIZE = { width: 1000, height: 1000 };

describe("natural translated-text layout", () => {
  it("is an exact identity while the option is disabled", () => {
    const block = makeBlock("긴 번역 문장을 그대로 유지합니다", {
      w: 80,
      h: 180,
    });
    const result = applyNaturalTextLayout(block, {
      enabled: false,
      pageSize: PAGE_SIZE,
      allowAutoVertical: true,
    });

    expect(result.changed).toBe(false);
    expect(result.strategy).toBe("disabled");
    expect(result.translatedText).toBe(block.translatedText);
    expect(result.renderDirection).toBe("horizontal");
    expect(block.wordBreak).toBe("keep-all");
  });

  it("uses word boundaries when several words fit on a line", () => {
    const block = makeBlock("자연스러운 문장 배치를 여러 단어로 확인합니다", {
      w: 240,
      h: 140,
    });
    const result = layout(block);

    expect(result.strategy).toBe("word");
    expect(result.translatedText).toContain("\n");
    expect(result.translatedText.replace(/\n/gu, " ")).toBe(
      block.translatedText,
    );
  });

  it("uses grapheme boundaries in a thin horizontal block", () => {
    const block = makeBlock("가나다라마바사아", { w: 46, h: 180 });
    const result = layout(block);

    expect(result.strategy).toBe("grapheme");
    expect(result.translatedText).toContain("\n");
    expect(result.translatedText.replace(/\n/gu, "")).toBe(
      block.translatedText,
    );
    expect(
      result.translatedText
        .split("\n")
        .every((line) => segmentNaturalTextGraphemes(line).length >= 2),
    ).toBe(true);
  });

  it("splits a long word without leaving a one-grapheme tail", () => {
    const block = makeBlock("초인공지능번역기술력", {
      w: 72,
      h: 180,
    });
    const result = layout(block);
    const lines = result.translatedText.split("\n");

    expect(result.strategy).toBe("grapheme");
    expect(lines.length).toBeGreaterThan(1);
    expect(
      lines.every((line) => segmentNaturalTextGraphemes(line).length > 1),
    ).toBe(true);
  });

  it("leaves an odd long word unchanged when hard lines would rewrap", () => {
    const block = makeBlock("초인공지능번역기술", { w: 72, h: 180 });
    const result = layout(block);

    expect(result.strategy).toBe("unchanged");
    expect(result.translatedText).toBe(block.translatedText);
    expect(result.diagnostics.estimatedFontSizePx).toBeUndefined();
  });

  it("does not count punctuation as a second readable character", () => {
    const cases = [
      ["나도 알고 있다고!", 52, 180],
      ["마을에... 튈 줄이야!?", 62, 190],
      ["네! 알고 있습니다!", 54, 180],
      ["어, 어째서...", 45, 160],
      ["설비가!?", 38, 150],
      ["【아티스】", 38, 150],
    ] as const;

    for (const [text, width, height] of cases) {
      const result = layout(makeBlock(text, { w: width, h: height }));
      expect(
        result.translatedText.split("\n").every((line) => {
          const graphemes = segmentNaturalTextGraphemes(line);
          const semanticCount = countSemanticNaturalGraphemes(
            graphemes,
            0,
            graphemes.length,
          );
          return semanticCount >= 2 || countSemanticTextGraphemes(text) <= 1;
        }),
        `${text}: ${result.translatedText}`,
      ).toBe(true);
    }
  });

  it("leaves punctuation-only decoration unchanged", () => {
    const block = makeBlock("…!?", { w: 30, h: 120 });
    const result = layout(block);

    expect(result.changed).toBe(false);
    expect(result.translatedText).toBe("…!?");
  });

  it("switches a narrow CJK block only when one vertical column wins", () => {
    const block = makeBlock(
      "세로쓰기",
      { w: 25, h: 300 },
      { sourceDirection: "vertical", wordBreak: undefined },
    );
    const result = layout(block, {
      allowAutoVertical: true,
      directionPreference: "auto",
    });

    expect(result.strategy).toBe("vertical");
    expect(result.renderDirection).toBe("vertical");
    expect(result.translatedText).toBe(block.translatedText);
    expect(result.diagnostics.oneColumnMaxFontPx).toBeGreaterThan(
      result.diagnostics.twoColumnMaxFontPx ?? 0,
    );
  });

  it("rejects vertical when one column does not decisively beat two", () => {
    const block = makeBlock(
      "가나다라마바사아자차",
      { w: 25, h: 160 },
      { sourceDirection: "vertical" },
    );
    const result = layout(block, {
      allowAutoVertical: true,
      directionPreference: "auto",
    });

    expect(result.strategy).not.toBe("vertical");
    expect(result.renderDirection).toBe("horizontal");
    expect(result.diagnostics.autoVerticalEligible).toBe(false);
    expect(result.diagnostics.oneColumnMaxFontPx).toBeGreaterThan(
      result.diagnostics.twoColumnMaxFontPx ?? 0,
    );
    expect(result.diagnostics.oneColumnMaxFontPx).toBeLessThan(
      (result.diagnostics.twoColumnMaxFontPx ?? 0) * 1.35,
    );
  });

  it("rejects auto vertical when its one-column font would be tiny", () => {
    const block = makeBlock(
      "가나다라마바사아",
      { w: 18, h: 500 },
      { sourceDirection: "vertical" },
    );
    const result = layout(block, {
      allowAutoVertical: true,
      directionPreference: "auto",
    });

    expect(result.strategy).not.toBe("vertical");
    expect(result.renderDirection).toBe("horizontal");
    expect(result.diagnostics.oneColumnMaxFontPx).toBeLessThan(16);
  });

  it("respects explicit horizontal and vertical formatting", () => {
    const thin = makeBlock(
      "세로쓰기",
      { w: 25, h: 300 },
      { sourceDirection: "vertical" },
    );
    const horizontal = layout(thin, {
      allowAutoVertical: true,
      directionPreference: "horizontal",
    });
    const explicitVertical = layout(
      { ...thin, renderDirection: "vertical" },
      {
        allowAutoVertical: false,
        directionPreference: "vertical",
      },
    );

    expect(horizontal.renderDirection).toBe("horizontal");
    expect(explicitVertical.changed).toBe(false);
    expect(explicitVertical.translatedText).toBe(thin.translatedText);
  });

  it("preserves existing hard breaks and is idempotent", () => {
    const block = makeBlock("이미 나뉜 문장\n두 번째 문장입니다", {
      w: 120,
      h: 180,
    });
    const first = layout(block);
    const second = layout({ ...block, translatedText: first.translatedText });

    expect(first.translatedText).toContain("\n");
    expect(second.translatedText).toBe(first.translatedText);
  });

  it("preserves intentional leading or repeated whitespace", () => {
    const leading = makeBlock("  들여쓴 문장입니다", { w: 120, h: 180 });
    const repeated = makeBlock("단어  사이 간격", { w: 120, h: 180 });

    expect(layout(leading).translatedText).toBe(leading.translatedText);
    expect(layout(repeated).translatedText).toBe(repeated.translatedText);
  });

  it("leaves rich-text markup untouched instead of corrupting spans", () => {
    const block = makeBlock("이 문장은 **아주 중요합니다**", {
      w: 90,
      h: 180,
    });
    const result = layout(block);

    expect(result.strategy).toBe("markup-preserved");
    expect(result.translatedText).toBe(block.translatedText);
  });

  it("keeps emoji ZWJ and combining-mark graphemes intact", () => {
    const text = "가족👨‍👩‍👧‍👦 cafe\u0301 확인";
    const block = makeBlock(text, { w: 55, h: 240 });
    const result = layout(block);

    expect(
      segmentNaturalTextGraphemes(result.translatedText.replace(/\s/gu, "")),
    ).toEqual(segmentNaturalTextGraphemes(text.replace(/\s/gu, "")));
  });

  it("does not reorder right-to-left text", () => {
    const text = "مرحبا بالعالم هذا اختبار";
    const block = makeBlock(text, { w: 100, h: 180 });
    const result = layout(block, { locale: "ar-SA" });

    expect(result.renderDirection).toBe("horizontal");
    expect(result.translatedText.replace(/\s/gu, "")).toBe(
      text.replace(/\s/gu, ""),
    );
  });

  it("uses renderBbox and supports pixel-space geometry", () => {
    const block = makeBlock("가나다라마바사", { w: 400, h: 100 });
    block.bboxSpace = "pixels";
    block.renderBbox = { x: 10, y: 10, w: 42, h: 180 };
    block.renderBboxSpace = "pixels";
    const result = layout(block);

    expect(result.diagnostics.widthPx).toBe(42);
    expect(result.strategy).toBe("unchanged");
    expect(result.translatedText).not.toContain("\n");
  });

  it("hard-breaks legacy blocks without materializing a wrapping policy", () => {
    const block = makeBlock(
      "기존 블록의 줄바꿈 서식은 그대로 둡니다",
      { w: 100, h: 180 },
      { wordBreak: undefined },
    );
    const result = layout(block);

    expect(result.changed).toBe(true);
    expect(result.translatedText).toContain("\n");
    expect(result.translatedText.replace(/\n/gu, " ")).toBe(
      block.translatedText,
    );
    expect(block.wordBreak).toBeUndefined();
  });

  it.each(["normal", "break-all"] as const)(
    "adds hard breaks without changing an explicit %s wrapping policy",
    (wordBreak) => {
      const block = makeBlock(
        "사용자가 고른 줄바꿈 방식은 그대로 유지합니다",
        { w: 100, h: 180 },
        { wordBreak },
      );
      const result = layout(block);

      expect(result.changed).toBe(true);
      expect(result.translatedText).toContain("\n");
      expect(block.wordBreak).toBe(wordBreak);
    },
  );

  it("falls back unchanged when readable hard lines would shrink too far", () => {
    const block = makeBlock(
      "가나다라마바사",
      { w: 25, h: 80 },
      { renderBbox: { x: 20, y: 20, w: 25, h: 80 } },
    );
    const result = layout(block);

    expect(result.strategy).toBe("unchanged");
    expect(result.translatedText).not.toContain("\n");
    expect(result.diagnostics.estimatedFontSizePx).toBeUndefined();
  });

  it("uses a circular bubble profile before its much smaller OCR bbox", () => {
    const text =
      "자연스러운 말풍선 모양에 맞춰 번역 문장을 보기 좋게 배치합니다";
    const block = makeBlock(
      text,
      { w: 40, h: 80 },
      {
        bboxSpace: "pixels",
        renderBbox: { x: 10, y: 10, w: 240, h: 220 },
        renderBboxSpace: "pixels",
        bubbleLayout: makeCircularBubbleLayout(),
        wordBreak: "break-word",
      },
    );
    const result = layout(block);
    const lines = result.translatedText.split("\n");
    const longestMiddleLine = Math.max(
      ...lines
        .slice(1, -1)
        .map((line) => segmentNaturalTextGraphemes(line).length),
    );

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("word");
    expect(result.diagnostics.shapeAware).toBe(true);
    expect(result.diagnostics.widthPx).toBe(240);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(longestMiddleLine).toBeGreaterThanOrEqual(
      segmentNaturalTextGraphemes(lines[0]).length,
    );
    expect(longestMiddleLine).toBeGreaterThanOrEqual(
      segmentNaturalTextGraphemes(lines.at(-1) ?? "").length,
    );
    expect(result.translatedText.replace(/\n/gu, " ")).toBe(text);
    expect(result.diagnostics.estimatedFontSizePx).toBeGreaterThanOrEqual(
      (result.diagnostics.baselineEstimatedFontSizePx ?? 0) * 0.95,
    );
  });

  it("keeps connected bubble lobes as independent ordered slot regions", () => {
    const layout = makeConnectedBubbleLayout();
    const plans = resolveNaturalShapeSlotPlans(layout, {
      blockExtentPx: 220,
      inlineExtentPx: 320,
      fontSizePx: 24,
      fontWidthScale: 1,
      lineHeight: 1.18,
      maximumSlotCount: 8,
    });
    const crossRegionPlan = plans.find(
      (plan) =>
        plan.slots.some((slot) => slot.regionIndex === 0) &&
        plan.slots.some((slot) => slot.regionIndex === 1),
    );

    expect(crossRegionPlan).toBeDefined();
    expect(crossRegionPlan?.slots.map((slot) => slot.regionIndex)).toEqual(
      [...(crossRegionPlan?.slots ?? [])]
        .sort((left, right) => left.regionIndex - right.regionIndex)
        .map((slot) => slot.regionIndex),
    );

    const text = "첫 번째 말풍선 문장입니다 두 번째 말풍선 문장도 이어집니다";
    const block = makeBlock(
      text,
      { w: 40, h: 80 },
      {
        bboxSpace: "pixels",
        renderBbox: { x: 10, y: 10, w: 320, h: 220 },
        renderBboxSpace: "pixels",
        bubbleLayout: layout,
        wordBreak: "break-word",
      },
    );
    const result = layoutBlock(block);
    expect(result.changed).toBe(true);
    expect(result.diagnostics.shapeAware).toBe(true);
    expect(
      result.translatedText
        .split("\n")
        .every((line) => segmentNaturalTextGraphemes(line).length >= 2),
    ).toBe(true);
    expect(result.translatedText.replace(/\s/gu, "")).toBe(
      text.replace(/\s/gu, ""),
    );
  });

  it("never overrides an existing horizontal bubble profile with auto vertical", () => {
    const block = makeBlock(
      "세로쓰기",
      { w: 25, h: 300 },
      {
        sourceDirection: "vertical",
        renderBbox: { x: 20, y: 20, w: 25, h: 300 },
        bubbleLayout: {
          version: 1,
          direction: "horizontal",
          confidence: 0.95,
          insetRatio: 0.05,
          regions: [
            {
              spans: [
                {
                  blockStart: 0,
                  blockEnd: 1,
                  inlineStart: 0,
                  inlineEnd: 1,
                },
              ],
            },
          ],
        },
      },
    );
    const result = layout(block, {
      allowAutoVertical: true,
      directionPreference: "auto",
    });

    expect(result.strategy).not.toBe("vertical");
    expect(result.renderDirection).toBe("horizontal");
    expect(result.diagnostics.autoVerticalEligible).toBe(false);
  });
});

function layout(
  block: TranslationBlock,
  overrides: Partial<Parameters<typeof applyNaturalTextLayout>[1]> = {},
) {
  return applyNaturalTextLayout(block, {
    enabled: true,
    pageSize: PAGE_SIZE,
    allowAutoVertical: false,
    directionPreference: "auto",
    locale: "ko",
    ...overrides,
  });
}

function layoutBlock(block: TranslationBlock) {
  return layout(block);
}

function makeBlock(
  translatedText: string,
  size: { w: number; h: number },
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 20, y: 20, ...size },
    bboxSpace: "normalized_1000",
    sourceText: "",
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 20,
    lineHeight: 1.18,
    letterSpacing: 0,
    fontWidthScale: 1,
    wordBreak: "keep-all",
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
    ...overrides,
  };
}

function makeCircularBubbleLayout(): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    insetRatio: 0.05,
    regions: [
      {
        spans: [
          {
            blockStart: 0,
            blockEnd: 0.18,
            inlineStart: 0.35,
            inlineEnd: 0.65,
          },
          {
            blockStart: 0.18,
            blockEnd: 0.35,
            inlineStart: 0.16,
            inlineEnd: 0.84,
          },
          {
            blockStart: 0.35,
            blockEnd: 0.65,
            inlineStart: 0.06,
            inlineEnd: 0.94,
          },
          {
            blockStart: 0.65,
            blockEnd: 0.82,
            inlineStart: 0.16,
            inlineEnd: 0.84,
          },
          {
            blockStart: 0.82,
            blockEnd: 1,
            inlineStart: 0.35,
            inlineEnd: 0.65,
          },
        ],
      },
    ],
  };
}

function makeConnectedBubbleLayout(): BubbleLayout {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.95,
    insetRatio: 0.05,
    regions: [
      {
        spans: [
          {
            blockStart: 0.08,
            blockEnd: 0.92,
            inlineStart: 0.04,
            inlineEnd: 0.46,
          },
        ],
      },
      {
        spans: [
          {
            blockStart: 0.08,
            blockEnd: 0.92,
            inlineStart: 0.54,
            inlineEnd: 0.96,
          },
        ],
      },
    ],
  };
}

function countSemanticTextGraphemes(value: string): number {
  const graphemes = segmentNaturalTextGraphemes(value);
  return countSemanticNaturalGraphemes(graphemes, 0, graphemes.length);
}
