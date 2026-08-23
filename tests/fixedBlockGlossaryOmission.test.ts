import { describe, expect, it } from "vitest";

const fixed =
  require("../src/main/runtime/semantic-ocr/fixed-block-translation.cjs") as {
    buildFixedBlockOverlayPayload: (
      plan: FixedBlockPlan,
      translations: FixedTranslationResult,
    ) => { items: Array<Record<string, unknown>> };
    buildFixedBlockTranslationPrompt: (
      plan: FixedBlockPlan,
      options: Record<string, unknown>,
    ) => string;
  };

type FixedBlockPlan = {
  version: 6;
  blocks: Array<{
    blockId: string;
    representativeId: number;
    candidateIds: number[];
    directionVoterCandidateIds: number[];
    jp: string;
    direction: "horizontal" | "vertical";
    bbox: { x1: number; y1: number; x2: number; y2: number };
    confidence: number;
    soundCandidate: boolean;
    fragments: Array<Record<string, unknown>>;
  }>;
};

type FixedTranslationResult = {
  items: Array<{ blockId: string; ko: string }>;
};

describe("fixed block glossary omission", () => {
  it("omits terms from the prompt while retaining immutable source", () => {
    const plan = makePlan();
    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, {
      sourceLanguage: "ja",
      targetLanguage: "ko",
      glossaryOmissionTerms: ["。"],
    });
    const promptBlocks = JSON.parse(
      prompt.split("fixedBlocks=")[1] ?? "[]",
    ) as Array<Record<string, unknown>>;

    expect(promptBlocks[0]?.jp).toBe("こんにちは");
    expect(plan.blocks[0]?.jp).toBe("こんにちは。");
    expect(
      fixed.buildFixedBlockOverlayPayload(plan, {
        items: [{ blockId: "B001", ko: "번역" }],
      }).items[0]?.jp,
    ).toBe("こんにちは。");
  });

  it("passes an empty model-facing source when the whole block is omitted", () => {
    const plan = makePlan();
    const block = plan.blocks[0];
    if (!block) throw new Error("fixed block fixture is missing");
    block.jp = "。";
    const prompt = fixed.buildFixedBlockTranslationPrompt(plan, {
      sourceLanguage: "ja",
      targetLanguage: "ko",
      glossaryOmissionTerms: ["。"],
    });
    const promptBlocks = JSON.parse(
      prompt.split("fixedBlocks=")[1] ?? "[]",
    ) as Array<Record<string, unknown>>;

    expect(promptBlocks[0]?.jp).toBe("");
    expect(plan.blocks[0]?.jp).toBe("。");
  });
});

function makePlan(): FixedBlockPlan {
  return {
    version: 6,
    blocks: [
      {
        blockId: "B001",
        representativeId: 1,
        candidateIds: [1],
        directionVoterCandidateIds: [1],
        jp: "こんにちは。",
        direction: "horizontal",
        bbox: { x1: 10, y1: 20, x2: 200, y2: 80 },
        confidence: 0.95,
        soundCandidate: false,
        fragments: [],
      },
    ],
  };
}
