import { describe, expect, it } from "vitest";

const fixed =
  require("../src/main/runtime/semantic-ocr/fixed-block-translation.cjs") as {
    parseFixedBlockTranslationPartialResponse: (
      raw: string,
      plan: FixedBlockPlan,
      options: Record<string, unknown>,
    ) => Record<string, unknown>;
  };

type FixedBlockPlan = {
  version: string;
  blocks: Array<{
    blockId: string;
    candidateIds: string[];
    directionVoterCandidateIds: string[];
    sourceTexts: string[];
    bbox: { x: number; y: number; width: number; height: number };
  }>;
};

const baseOptions = {
  sourceLanguage: "Japanese",
  targetLanguage: "Korean",
};

describe("fixed-block partial recovery", () => {
  it("salvages only unique contract-valid expected ids", () => {
    const partial = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          { blockId: "B002", ko: "둘째" },
          { blockId: "B001", ko: "첫째" },
          { blockId: "B001", ko: "중복" },
          { blockId: "B003", ko: "俺" },
          { blockId: "B999", ko: "예상하지 않은 항목" },
          null,
        ],
        pageContext: { visualSummary: "유효한 장면 정보" },
        commentary: "금지된 최상위 필드는 복구 과정에서 무시한다.",
      }),
      singletonPlan(3),
      { ...baseOptions, collectPageContext: true },
    );

    expect(partial).toEqual({
      translations: {
        items: [{ blockId: "B002", ko: "둘째" }],
        pageContext: { visualSummary: "유효한 장면 정보" },
      },
      retryBlockIds: ["B001", "B003"],
      retryReasons: {
        B001: ["fixed-block-translation-duplicate"],
        B003: ["fixed-block-translation-source-script-leak"],
      },
    });
  });

  it("keeps Korean-safe elongation without accepting Japanese words", () => {
    const partial = fixed.parseFixedBlockTranslationPartialResponse(
      JSON.stringify({
        items: [
          { blockId: "B001", ko: "무리예요ーー!!" },
          { blockId: "B002", ko: "원작에서는 瘴気の 항체약" },
        ],
      }),
      singletonPlan(2),
      baseOptions,
    );

    expect(partial).toMatchObject({
      translations: { items: [] },
      retryBlockIds: ["B001", "B002"],
      retryReasons: {
        B001: ["fixed-block-translation-source-script-leak"],
        B002: ["fixed-block-translation-source-script-leak"],
      },
      targetTypographyFallbackTranslations: {
        items: [{ blockId: "B001", ko: "무리예요~~!!" }],
      },
    });
  });
});

function singletonPlan(count: number): FixedBlockPlan {
  return {
    version: "fixed-block-v6",
    blocks: Array.from({ length: count }, (_, index) => ({
      blockId: `B${String(index + 1).padStart(3, "0")}`,
      candidateIds: [`C${index + 1}`],
      directionVoterCandidateIds: [`C${index + 1}`],
      sourceTexts: ["原文"],
      bbox: { x: index * 20, y: 0, width: 10, height: 10 },
    })),
  };
}
