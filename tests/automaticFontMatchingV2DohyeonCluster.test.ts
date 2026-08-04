import { describe, expect, it } from "vitest";
import type {
  FontMatchingSemanticRole,
  RankedFontCandidateV2,
} from "../src/shared/fontMatchingProfileTypes";
import {
  applyAutomaticFontPageConsistency,
  buildAutomaticFontPageConsistencyPlan,
  mergeAutomaticFontPageConsistencyState,
} from "../src/main/pipeline/automaticFontMatchingV2PageConsistency";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";

describe("Dohyeon direct pixel neighborhood rescue", () => {
  it("replays page 30 with one direct seed rescuing two direct top-five neighbors", () => {
    const rows = pageThirtyRows();
    const plan = buildAutomaticFontPageConsistencyPlan(rows);

    expect(plan.get("page-30-block-4")).toEqual({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
    });
    for (const blockId of ["page-30-block-3", "page-30-block-5"]) {
      expect(plan.get(blockId)).toMatchObject({
        mode: "local_visual_variant",
        dohyeonMorphologyVeto: false,
        dohyeonDominanceClusterRescue: true,
      });
      const row = rows.find((entry) => entry.blockId === blockId);
      const result = applyAutomaticFontPageConsistency(
        row?.localEvidence.rankedCandidates ?? [],
        mergeAutomaticFontPageConsistencyState(undefined, plan.get(blockId)),
      );
      expect(result[0]).toMatchObject({ fontId: "dohyeon", confidence: 0.82 });
      expect(result[0]?.reasonCodes).toEqual(
        expect.arrayContaining([
          "dohyeon_same_page_top5_cluster_rescue",
          "pixel_top5_cosine_distance_0_02",
          "pixel_only_policy",
        ]),
      );
    }
  });

  it("rejects a two-row seed neighborhood", () => {
    const plan = buildAutomaticFontPageConsistencyPlan(
      pageThirtyRows().slice(0, 2),
    );

    expect(plan.get("page-30-block-3")).toMatchObject({
      dohyeonMorphologyVeto: true,
    });
    expect(plan.get("page-30-block-3")).not.toHaveProperty(
      "dohyeonDominanceClusterRescue",
    );
  });

  it("rejects a row beyond direct cosine distance despite a transitive chain", () => {
    const rows = [
      vectorRow("cluster-seed", 0, true),
      vectorRow("cluster-near-a", 0.155, false),
      vectorRow("cluster-transitive-only", 0.319, false),
      vectorRow("cluster-near-b", 0.1, false),
    ];
    const plan = buildAutomaticFontPageConsistencyPlan(rows);

    expect(plan.get("cluster-near-a")).toMatchObject({
      dohyeonDominanceClusterRescue: true,
    });
    expect(plan.get("cluster-near-b")).toMatchObject({
      dohyeonDominanceClusterRescue: true,
    });
    expect(plan.get("cluster-transitive-only")).toMatchObject({
      dohyeonMorphologyVeto: true,
    });
    expect(plan.get("cluster-transitive-only")).not.toHaveProperty(
      "dohyeonDominanceClusterRescue",
    );
  });

  it("rejects otherwise close evidence from a different text direction", () => {
    const rows = pageThirtyRows();
    const items = rows.map((_row, index) => ({
      type: "nonsolid" as const,
      direction: index === 2 ? ("horizontal" as const) : ("vertical" as const),
      bbox: { x: index * 200, y: 0, w: 100, h: 120 },
    }));
    const plan = buildAutomaticFontPageConsistencyPlan(rows, items);

    for (const blockId of ["page-30-block-3", "page-30-block-5"]) {
      expect(plan.get(blockId)).toMatchObject({ dohyeonMorphologyVeto: true });
      expect(plan.get(blockId)).not.toHaveProperty(
        "dohyeonDominanceClusterRescue",
      );
    }
  });
});

function pageThirtyRows(): VerifiedAutomaticFontPixelInferenceV2[] {
  return [
    row({
      blockId: "page-30-block-3",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.93281, 0.82),
        pixelCandidate("black-han-sans", 2, 0.033272),
        pixelCandidate("gasoek-one", 3, 0.012885),
        pixelCandidate("jua", 4, 0.005632),
        pixelCandidate("griun-pol-sensibility", 5, 0.005063),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.415052,
        medianComponentDistanceMean: 1.227255,
        medianComponentFill: 0.507143,
      }),
    }),
    row({
      blockId: "page-30-block-4",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.908156, 0.82),
        pixelCandidate("black-han-sans", 2, 0.030356),
        pixelCandidate("gasoek-one", 3, 0.018645),
        pixelCandidate("griun-pol-sensibility", 4, 0.015094),
        pixelCandidate("nanum-barun-gothic", 5, 0.00883),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.586022,
        medianComponentDistanceMean: 1.330821,
        medianComponentFill: 0.5,
      }),
    }),
    row({
      blockId: "page-30-block-5",
      candidates: [
        pixelCandidate("dohyeon", 1, 0.87624, 0.82),
        pixelCandidate("griun-pol-sensibility", 2, 0.050731),
        pixelCandidate("black-han-sans", 3, 0.017342),
        pixelCandidate("jua", 4, 0.015225),
        pixelCandidate("mongtori", 5, 0.007639),
      ],
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 1.42588,
        medianComponentDistanceMean: 1.314068,
        medianComponentFill: 0.438564,
      }),
    }),
  ];
}

function vectorRow(
  blockId: string,
  axisScore: number,
  morphologySeed: boolean,
): VerifiedAutomaticFontPixelInferenceV2 {
  return row({
    blockId,
    candidates: [
      pixelCandidate("dohyeon", 1, 0.9, 0.82),
      pixelCandidate("black-han-sans", 2, 0.05),
      pixelCandidate("gasoek-one", 3, axisScore),
      pixelCandidate("jua", 4, 0),
      pixelCandidate("ridi-batang", 5, 0),
    ],
    glyphMorphology: morphology({
      globalForegroundDistanceMean: morphologySeed ? 1.8 : 1.4,
      medianComponentDistanceMean: morphologySeed ? 1.7 : 1.2,
      medianComponentFill: 0.4,
    }),
  });
}

function row({
  blockId,
  candidates,
  glyphMorphology,
}: {
  blockId: string;
  candidates: RankedFontCandidateV2[];
  glyphMorphology: NonNullable<
    VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]
  >;
}): VerifiedAutomaticFontPixelInferenceV2 {
  const role: FontMatchingSemanticRole = "dialogue";
  return {
    kind: "verified_pixel_inference",
    pageId: "page-30",
    blockId,
    modelVersion: "fixture-model",
    candidateOrderSha256: "a".repeat(64),
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: { primary: role, confidence: 0.99, alternatives: [] },
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
    glyphMorphology,
    localEvidence: {
      rankedCandidates: candidates,
      calibratedConfidence: 0.82,
      noneAcceptable: false,
      catalogVersion: "fixture-catalog",
      modelVersion: "fixture-model",
      rendererHash: "b".repeat(64),
    },
  };
}

function morphology(
  overrides: Partial<
    NonNullable<VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]>
  > = {},
): NonNullable<VerifiedAutomaticFontPixelInferenceV2["glyphMorphology"]> {
  return {
    contractVersion: "font-matching-glyph-morphology-v1",
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    maskWidth: 80,
    maskHeight: 40,
    otsuThreshold: 120,
    foregroundPolarity: "dark",
    foregroundPixelCount: 320,
    connectedComponentCount: 4,
    globalForegroundDistanceMean: 1.8,
    medianComponentDistanceMean: 1.8,
    medianComponentFill: 0.62,
    foregroundMeanLuma: 30,
    backgroundMeanLuma: 235,
    ...overrides,
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
