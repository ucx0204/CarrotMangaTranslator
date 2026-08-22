import { describe, expect, it } from "vitest";
import { applyAutomaticFontChapterBodyPrior } from "../src/main/pipeline/automaticFontMatchingV2ChapterPrior";
import { resolveAutomaticDecisionCalibration } from "../src/main/pipeline/automaticFontMatchingV2DecisionCalibration";
import { applyDohyeonLocalPolicy } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyDohyeonSelection";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimePolicy } from "../src/main/pipeline/fontMatchingRuntimePolicyContract";
import type { RankedFontCandidateV2 } from "../src/shared/fontMatchingProfileTypes";

const runtimePolicy: FontMatchingRuntimePolicy = {
  automaticMutation: {
    minimumAutomaticConfidence: 0.8,
    minimumRoleConfidence: 0.82,
    minimumIntentionalOverrideConfidence: 0.9,
    intentionalOverrideMinimumScoreMargin: 0.1,
  },
  chapterPrior: {
    maximumScoreContribution: 0.06,
    minimumAnchorEvidenceCount: 3,
    localOverrideMinimumScoreMargin: 0.05,
  },
};

describe("automatic font matching deterministic edge policies", () => {
  it("orders tied chapter candidates and honors a disabled score cap", () => {
    const ranked = [
      rankedCandidate("z-local", 0.9, 1, 1, 0.9),
      rankedCandidate("a-local", 0.9, 1, 3, 0.9),
      rankedCandidate("chapter-font", 0.8, 2, 2, 0.2),
    ];
    const state = {
      automaticStrategy: "body_consistency_soft" as const,
      bodyConsistencyFontId: "chapter-font",
      bodyConsistencyScoreBoost: 0.06,
    };

    const adjusted = applyAutomaticFontChapterBodyPrior(
      ranked,
      state,
      runtimePolicy,
    );
    expect(adjusted.map((candidate) => candidate.fontId)).toEqual([
      "chapter-font",
      "a-local",
      "z-local",
    ]);
    expect(adjusted[0]?.confidence).toBe(0.9);

    const disabledPolicy: FontMatchingRuntimePolicy = {
      ...runtimePolicy,
      chapterPrior: {
        ...runtimePolicy.chapterPrior,
        maximumScoreContribution: 0,
      },
    };
    expect(
      applyAutomaticFontChapterBodyPrior(ranked, state, disabledPolicy),
    ).toBe(ranked);
  });

  it("keeps fail-closed calibration when every candidate is unrenderable", () => {
    const pixelInference: VerifiedAutomaticFontPixelInferenceV2 = {
      kind: "verified_pixel_inference",
      pageId: "page",
      blockId: "block",
      modelVersion: "model",
      candidateOrderSha256: "candidate-order",
      inputBoundary: {
        source: "user_page",
        datasetSplit: null,
        qaOverlay: false,
      },
      rolePrediction: {
        primary: "dialogue",
        confidence: 0.9,
        alternatives: [],
      },
      sourceStyle: {
        serifness: 0.1,
        weight: 0.5,
        width: 0.5,
        roundness: 0.4,
        strokeContrast: 0.3,
        handwritten: 0.1,
        angularity: 0.2,
        irregularity: 0.1,
        slant: 0.1,
        energy: 0.2,
        unknownFields: [],
      },
      treatment: {
        orientation: "horizontal",
        outline: "none",
        shadow: "none",
        fill: "solid",
        distortion: "none",
        polarity: "normal",
        colorMode: "monochrome",
      },
      selectionCalibration: {
        applied: false,
        fallbackReason: "score_below_operating_point",
        operatingFamily: "body",
        selectionScore: 0.1,
        globalRiskLowerConfidenceBound: 0.9,
      },
      localEvidence: {
        rankedCandidates: [
          {
            ...rankedCandidate("retired", 0.9, 1, 1, 0.9),
            renderStatus: "unrenderable",
            unrenderableReason: "font_retired_by_product_policy",
          },
        ],
        calibratedConfidence: 0.9,
        noneAcceptable: false,
        catalogVersion: "catalog",
        modelVersion: "model",
        rendererHash: "renderer",
      },
    };

    expect(
      resolveAutomaticDecisionCalibration(runtimePolicy, pixelInference),
    ).toMatchObject({
      minimumAutomaticConfidence: 1,
      minimumRoleConfidence:
        runtimePolicy.automaticMutation.minimumRoleConfidence,
    });
  });

  it("rejects an unrenderable Dohyeon recovery target", () => {
    const dohyeon = rankedCandidate("dohyeon", 0.9, 1, 1, 0.9);
    const unavailableTarget: RankedFontCandidateV2 = {
      ...rankedCandidate("jua", 0.8, 2, 2, 0),
      renderStatus: "unrenderable",
      unrenderableReason: "font_retired_by_product_policy",
    };

    const adjusted = applyDohyeonLocalPolicy([dohyeon, unavailableTarget], {
      pageBalloonConsistencyMode: "local_visual_variant",
      pageBalloonDohyeonMorphologyVeto: true,
      pageBalloonDohyeonMorphologyRecoveryFontId: "jua",
      pageBalloonDohyeonMorphologyRecoveryRoute: "non_dohyeon_top3",
    });

    expect(
      adjusted?.find((candidate) => candidate.fontId === "dohyeon"),
    ).toMatchObject({
      confidence: 0,
      reasonCodes: expect.arrayContaining(["dohyeon_glyph_morphology_veto"]),
    });
  });
});

function rankedCandidate(
  fontId: string,
  score: number,
  rank: number,
  rawPixelRank: number,
  confidence: number,
): RankedFontCandidateV2 {
  return {
    rank,
    rawPixelRank,
    rawPixelScore: score,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: score,
    roleFit: score,
    layoutFit: 0,
    glyphCoverage: 1,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore: score,
    confidence,
    reasonCodes: ["pixel_model"],
  };
}
