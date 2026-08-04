import { describe, expect, it } from "vitest";
import {
  applyAutomaticFontPageConsistency,
  buildAutomaticFontPageConsistencyPlan,
  mergeAutomaticFontPageConsistencyState,
} from "../src/main/pipeline/automaticFontMatchingV2PageConsistency";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { RankedFontCandidateV2 } from "../src/shared/fontMatchingProfileTypes";

describe("noninverse Dohyeon strong page-anchor recovery", () => {
  it("keeps inverse page-anchor recovery on its separate evidence route", () => {
    const anchors = strongRidiAnchorRows(4);
    const target = inverseDohyeonTarget("inverse-target", 7);

    const pageState = buildAutomaticFontPageConsistencyPlan([
      ...anchors,
      target,
    ]).get(target.blockId);
    expect(pageState).toMatchObject({
      mode: "local_visual_variant",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 4,
      anchorSupportShare: 1,
      dohyeonMorphologyRecoveryFontId: "ridi-batang",
      dohyeonMorphologyRecoveryRoute: "inverse_page_anchor",
    });

    const result = applyAutomaticFontPageConsistency(
      target.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, pageState),
    );
    expect(result[0]).toMatchObject({
      fontId: "ridi-batang",
      confidence: 0.82,
      rawPixelRank: 7,
    });
    expect(result[0]?.reasonCodes).toEqual(
      expect.arrayContaining([
        "inverse_page_body_anchor_after_dohyeon_veto",
        "pixel_raw_top8_veto_recovery_boundary",
        "pixel_only_policy",
      ]),
    );
    expect(result[0]?.reasonCodes).not.toContain(
      "strong_page_anchor_after_dohyeon_veto",
    );
  });

  it("replays page 29 block 5 through the unanimous raw-rank-seven anchor", () => {
    const anchors = strongRidiAnchorRows(4);
    const target = noninverseDohyeonTarget("page-29-block-5", 7);

    const pageState = buildAutomaticFontPageConsistencyPlan([
      ...anchors,
      target,
    ]).get(target.blockId);
    expect(pageState).toMatchObject({
      mode: "local_visual_variant",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 4,
      anchorSupportShare: 1,
      dohyeonMorphologyVeto: true,
      dohyeonMorphologyRecoveryFontId: "ridi-batang",
      dohyeonMorphologyRecoveryRoute: "strong_page_anchor",
    });

    const result = applyAutomaticFontPageConsistency(
      target.localEvidence.rankedCandidates,
      mergeAutomaticFontPageConsistencyState(undefined, pageState),
    );
    expect(result[0]).toMatchObject({
      fontId: "ridi-batang",
      confidence: 0.82,
      rawPixelRank: 7,
    });
    expect(result[0]?.reasonCodes).toEqual(
      expect.arrayContaining([
        "strong_page_anchor_after_dohyeon_veto",
        "pixel_raw_top8_veto_recovery_boundary",
        "pixel_only_policy",
      ]),
    );
    expect(result[0]?.reasonCodes).not.toContain(
      "inverse_page_body_anchor_after_dohyeon_veto",
    );
  });

  it("rejects page 26 when the anchor candidate is raw rank twelve", () => {
    const anchors = strongRidiAnchorRows(4);
    const target = noninverseDohyeonTarget("page-26-block-2", 12);
    const plan = buildAutomaticFontPageConsistencyPlan([...anchors, target]);

    expect(plan.get(anchors[0]?.blockId ?? "")).toMatchObject({
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 4,
      anchorSupportShare: 1,
    });
    expect(plan.get(target.blockId)).toMatchObject({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
      dohyeonMorphologyVeto: true,
      dohyeonMorphologyRecoveryFontId: "griun-pol-sensibility",
      dohyeonMorphologyRecoveryRoute: "non_dohyeon_top3",
    });
    expect(plan.get(target.blockId)).not.toHaveProperty("anchorFontId");
  });

  it("rejects recovery with only three anchor seeds", () => {
    const anchors = strongRidiAnchorRows(3);
    const target = noninverseDohyeonTarget("three-seed-target", 7);
    const plan = buildAutomaticFontPageConsistencyPlan([...anchors, target]);

    expect(plan.get(anchors[0]?.blockId ?? "")).toMatchObject({
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 3,
      anchorSupportShare: 1,
    });
    expect(plan.get(target.blockId)).toMatchObject({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
      dohyeonMorphologyRecoveryFontId: "griun-pol-sensibility",
      dohyeonMorphologyRecoveryRoute: "non_dohyeon_top3",
    });
    expect(plan.get(target.blockId)).not.toHaveProperty("anchorFontId");
  });

  it("rejects recovery below unanimous anchor support", () => {
    const anchors = strongRidiAnchorRows(4);
    const target = noninverseDohyeonTarget("partial-support-target", 7);
    const partialSupportSeed = inference(
      "partial-support-seed",
      [
        pixelCandidate("nanum-myeongjo", 1, 0.25, 0.82),
        pixelCandidate("dohyeon", 2, 0.22),
        pixelCandidate("seoul-hangang", 3, 0.2),
        pixelCandidate("ridi-batang", 4, 0.18),
        pixelCandidate("jua", 5, 0.15),
      ],
      false,
    );
    const plan = buildAutomaticFontPageConsistencyPlan([
      ...anchors,
      partialSupportSeed,
      target,
    ]);

    expect(plan.get(anchors[0]?.blockId ?? "")).toMatchObject({
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 4,
      anchorSupportShare: 0.8,
    });
    expect(plan.get(target.blockId)).toMatchObject({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
      dohyeonMorphologyRecoveryFontId: "griun-pol-sensibility",
      dohyeonMorphologyRecoveryRoute: "non_dohyeon_top3",
    });
    expect(plan.get(target.blockId)).not.toHaveProperty("anchorFontId");
  });
});

function strongRidiAnchorRows(
  count: number,
): VerifiedAutomaticFontPixelInferenceV2[] {
  return Array.from({ length: count }, (_entry, index) =>
    inference(
      `strong-ridi-anchor-${index}`,
      [
        pixelCandidate("ridi-batang", 1, 0.58, 0.82),
        pixelCandidate("nanum-myeongjo", 2, 0.15),
        pixelCandidate("jua", 3, 0.12),
        pixelCandidate("dohyeon", 4, 0.1),
      ],
      false,
    ),
  );
}

function noninverseDohyeonTarget(
  blockId: string,
  ridiRawRank: number,
): VerifiedAutomaticFontPixelInferenceV2 {
  return inference(
    blockId,
    [
      pixelCandidate("dohyeon", 1, 0.616, 0.82),
      pixelCandidate("griun-pol-sensibility", 2, 0.177),
      pixelCandidate("black-han-sans", 3, 0.07),
      pixelCandidate("gasoek-one", 4, 0.045),
      pixelCandidate("kirang-haerang", 5, 0.035),
      pixelCandidate("jua", 6, 0.025),
      pixelCandidate("ridi-batang", ridiRawRank, 0.014),
      pixelCandidate("nanum-myeongjo", ridiRawRank + 1, 0.012),
    ],
    true,
  );
}

function inverseDohyeonTarget(
  blockId: string,
  ridiRawRank: number,
): VerifiedAutomaticFontPixelInferenceV2 {
  const target = noninverseDohyeonTarget(blockId, ridiRawRank);
  const glyphMorphology = target.glyphMorphology;
  if (!glyphMorphology) throw new Error("Fixture morphology is required.");
  return {
    ...target,
    glyphMorphology: {
      ...glyphMorphology,
      foregroundPolarity: "light",
      foregroundMeanLuma: 240,
      backgroundMeanLuma: 20,
    },
  };
}

function inference(
  blockId: string,
  candidates: RankedFontCandidateV2[],
  morphologyVeto: boolean,
): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    kind: "verified_pixel_inference",
    pageId: "fixture-page",
    blockId,
    modelVersion: "fixture-model",
    candidateOrderSha256: "a".repeat(64),
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: {
      primary: morphologyVeto ? "emphasis_dialogue" : "dialogue",
      confidence: 0.99,
      alternatives: [],
    },
    sourceStyle: {
      serifness: 0.5,
      weight: 0.58,
      width: 0.5,
      roundness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.05,
      angularity: 0.5,
      irregularity: 0.1,
      slant: 0.05,
      energy: 0.45,
      unknownFields: [],
    },
    treatment: {
      orientation: "vertical",
      outline: "none",
      shadow: "none",
      fill: "solid",
      distortion: "none",
      polarity: "normal",
      colorMode: "monochrome",
    },
    selectionCalibration: {
      applied: true,
      fallbackReason: null,
      operatingFamily: "body",
      selectionScore: 0.9,
      globalRiskLowerConfidenceBound: 0.76,
    },
    glyphMorphology: {
      contractVersion: "font-matching-glyph-morphology-v1",
      maskSource: "raw_grayscale_otsu_minority_area3",
      distanceTransform: "opencv_dist_l2_mask5",
      connectivity: 8,
      maskWidth: 80,
      maskHeight: 40,
      otsuThreshold: 120,
      foregroundPolarity: "dark",
      foregroundPixelCount: 320,
      connectedComponentCount: morphologyVeto ? 20 : 4,
      globalForegroundDistanceMean: morphologyVeto ? 1.2 : 1.8,
      medianComponentDistanceMean: morphologyVeto ? 1.1 : 1.8,
      medianComponentFill: morphologyVeto ? 0.4 : 0.62,
      foregroundMeanLuma: 30,
      backgroundMeanLuma: 235,
    },
    localEvidence: {
      rankedCandidates: candidates,
      calibratedConfidence: candidates[0]?.confidence ?? 0,
      noneAcceptable: false,
      catalogVersion: "fixture-catalog",
      modelVersion: "fixture-model",
      rendererHash: "b".repeat(64),
    },
  };
}

function pixelCandidate(
  fontId: string,
  rawPixelRank: number,
  rawPixelScore: number,
  confidence = 0,
): RankedFontCandidateV2 {
  return {
    rank: rawPixelRank,
    rawPixelRank,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 0.8,
    roleFit: 0.9,
    layoutFit: null,
    glyphCoverage: null,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    rawPixelScore,
    totalScore: rawPixelScore,
    confidence,
    reasonCodes: ["fixture", "supervised_top3_acceptability_rerank"],
  };
}
