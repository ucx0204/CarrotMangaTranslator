import { describe, expect, it } from "vitest";
import type {
  FontMatchingSemanticRole,
  RankedFontCandidateV2,
} from "../src/shared/fontMatchingProfileTypes";
import { applyPageRelativeQaConsistencyGuards } from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyPlan";
import type {
  AutomaticFontPageConsistencyState,
  PageEvidenceRow,
} from "../src/main/pipeline/automaticFontMatchingV2PageConsistencyShared";
import type {
  FontMatchingPageRelativeBaselineConsistencyState,
  VerifiedAutomaticFontPixelInferenceV2,
} from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";

describe("page-relative downstream consistency guard", () => {
  it("prevents page-35-like rerouted ordinary rows from splitting final anchors", () => {
    const rows = [
      evidenceRow(
        inference({
          blockId: "ordinary-a",
          candidates: [
            candidate("nanum-gothic", 1, 0.45, 0.8),
            candidate("ridi-batang", 2, 0.4),
          ],
        }),
      ),
      evidenceRow(
        inference({
          blockId: "ordinary-b",
          candidates: [
            candidate("ridi-batang", 1, 0.48, 0.8),
            candidate("nanum-gothic", 2, 0.4),
          ],
        }),
      ),
    ];
    const states = new Map<string, AutomaticFontPageConsistencyState>();

    applyPageRelativeQaConsistencyGuards(states, rows);

    for (const row of rows) {
      expect(states.get(row.inference.blockId)).toMatchObject({
        mode: "page_anchor",
        anchorFontId: "ridi-batang",
        printedFamily: "serif",
        recoveredBody: true,
        ordinaryMorphologyConsensus: true,
      });
    }
  });

  it("exactly restores the page-38 unchanged row's baseline page state", () => {
    const baselinePageConsistencyState = {
      mode: "page_anchor",
      anchorFontId: "ridi-batang",
      anchorEvidenceCount: 2,
      anchorSupportShare: 1,
      printedFamily: "serif",
      recoveredBody: false,
      ordinaryMorphologyConsensus: false,
    } as const;
    const row = evidenceRow(
      inference({
        blockId: "unchanged-body",
        status: "unchanged",
        originalRole: "dialogue",
        projectedRole: "dialogue",
        reasonCodes: [],
        baselinePageConsistencyState,
        candidates: [
          candidate("nanum-myeongjo", 1, 0.391, 0.8),
          candidate("ridi-batang", 2, 0.366),
        ],
      }),
    );
    const states = new Map<string, AutomaticFontPageConsistencyState>();

    applyPageRelativeQaConsistencyGuards(states, [row]);

    expect(states.get(row.inference.blockId)).toEqual(
      baselinePageConsistencyState,
    );
  });

  it("keeps an explicitly preserved genuine variant local", () => {
    const row = evidenceRow(
      inference({
        blockId: "preserved-emphasis",
        status: "unchanged",
        originalRole: "emphasis_dialogue",
        projectedRole: "emphasis_dialogue",
        reasonCodes: ["preserve_strong_local_variant_pixel_gap"],
        baselinePageConsistencyState: {
          mode: "local_visual_variant",
          anchorEvidenceCount: 0,
          recoveredBody: false,
        },
        candidates: [
          candidate("dohyeon", 1, 0.8, 0.8),
          candidate("ridi-batang", 2, 0.1),
        ],
      }),
    );
    const states = new Map<string, AutomaticFontPageConsistencyState>([
      [
        row.inference.blockId,
        {
          mode: "page_anchor",
          anchorFontId: "ridi-batang",
          anchorEvidenceCount: 3,
          anchorSupportShare: 1,
          printedFamily: "serif",
        },
      ],
    ]);

    applyPageRelativeQaConsistencyGuards(states, [row]);

    expect(states.get(row.inference.blockId)).toMatchObject({
      mode: "local_visual_variant",
      anchorEvidenceCount: 0,
      recoveredBody: false,
    });
    expect(states.get(row.inference.blockId)?.anchorFontId).toBeUndefined();
  });

  it("fails closed when one rerouted ordinary row lacks the anchor in raw top3", () => {
    const eligible = evidenceRow(
      inference({
        blockId: "eligible",
        candidates: [
          candidate("nanum-gothic", 1, 0.5, 0.8),
          candidate("ridi-batang", 2, 0.4),
        ],
      }),
    );
    const ineligible = evidenceRow(
      inference({
        blockId: "outside-top3",
        candidates: [
          candidate("nanum-gothic", 1, 0.5, 0.8),
          candidate("nanum-myeongjo", 2, 0.3),
          candidate("seoul-hangang", 3, 0.2),
          candidate("ridi-batang", 4, 0.1),
        ],
      }),
    );
    const states = new Map<string, AutomaticFontPageConsistencyState>();

    applyPageRelativeQaConsistencyGuards(states, [eligible, ineligible]);

    expect(states.has(eligible.inference.blockId)).toBe(false);
    expect(states.has(ineligible.inference.blockId)).toBe(false);
  });

  it("rejects a mixed stale-v1 and v2 audit before mutating page state", () => {
    const valid = evidenceRow(
      inference({
        blockId: "valid-v2",
        status: "unchanged",
        originalRole: "dialogue",
        projectedRole: "dialogue",
        reasonCodes: [],
        baselinePageConsistencyState: {
          mode: "stable_body",
          anchorFontId: "ridi-batang",
          anchorEvidenceCount: 1,
        },
        candidates: [candidate("ridi-batang", 1, 0.8, 0.8)],
      }),
    );
    const staleInference = inference({
      blockId: "stale-v1",
      status: "unchanged",
      originalRole: "dialogue",
      projectedRole: "dialogue",
      reasonCodes: [],
      candidates: [candidate("ridi-batang", 1, 0.8, 0.8)],
    });
    const staleAudit = staleInference.pageRelativeRoleQa;
    if (!staleAudit) throw new Error("Fixture QA audit is missing.");
    Reflect.set(
      staleAudit,
      "policyVersion",
      "font-matching-page-relative-role-qa-v1",
    );
    const stale = evidenceRow(staleInference);
    const states = new Map<string, AutomaticFontPageConsistencyState>();

    expect(() =>
      applyPageRelativeQaConsistencyGuards(states, [valid, stale]),
    ).toThrow("policy version mismatch");
    expect(states.size).toBe(0);
  });
});

function evidenceRow(
  pixelInference: VerifiedAutomaticFontPixelInferenceV2,
): PageEvidenceRow {
  return {
    inference: pixelInference,
    directBodyFamily: "serif",
    strongBodySeed: true,
    family: "serif",
    recoveredBody: false,
    geometryComponentForced: false,
    geometryComponentId: null,
    geometryComponentAnchorFontId: null,
    geometryComponentEvidenceCount: 0,
    dohyeonMorphologyVeto: false,
  };
}

function inference({
  blockId,
  candidates,
  status = "applied",
  originalRole = "emphasis_dialogue",
  projectedRole = "dialogue",
  reasonCodes = ["page_relative_dominant_ordinary_morphology"],
  baselinePageConsistencyState = null,
}: {
  blockId: string;
  candidates: readonly RankedFontCandidateV2[];
  status?: NonNullable<
    VerifiedAutomaticFontPixelInferenceV2["pageRelativeRoleQa"]
  >["status"];
  originalRole?: FontMatchingSemanticRole;
  projectedRole?: FontMatchingSemanticRole;
  reasonCodes?: readonly string[];
  baselinePageConsistencyState?: FontMatchingPageRelativeBaselineConsistencyState | null;
}): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    kind: "verified_pixel_inference",
    pageId: "page-1",
    blockId,
    modelVersion: "fixture-model",
    candidateOrderSha256: "a".repeat(64),
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: {
      primary: projectedRole,
      confidence: 0.95,
      alternatives: [],
    },
    scoreRoute: {
      family: projectedRole === "dialogue" ? "body" : "variant",
      outputName:
        projectedRole === "dialogue"
          ? "body_candidate_scores"
          : "variant_candidate_scores",
      resolvedRole: projectedRole,
    },
    pageRelativeRoleQa: {
      policyVersion: "font-matching-page-relative-role-qa-v2",
      status,
      originalRole,
      projectedRole,
      routeFamily: projectedRole === "dialogue" ? "body" : "variant",
      sourceGeometryDirection: null,
      clusterId: "vertical:dominant-1",
      clusterBodyAnchorFontId: "ridi-batang",
      baselinePageConsistencyState,
      preferredPeerFontId: null,
      peerBlockId: null,
      reasonCodes,
      confidencePolicy: "preserve_original_pixel_primary_confidence",
      applyRateGuard: "selection_calibration_non_decreasing",
    },
    sourceStyle: {
      serifness: 0.5,
      weight: 0.5,
      width: 0.5,
      roundness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0.5,
      angularity: 0.5,
      irregularity: 0.5,
      slant: 0.5,
      energy: 0.5,
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
      operatingFamily: projectedRole === "dialogue" ? "body" : "variant",
      selectionScore: 0.9,
      globalRiskLowerConfidenceBound: 0.7,
    },
    localEvidence: {
      rankedCandidates: candidates,
      calibratedConfidence: 0.8,
      noneAcceptable: false,
      catalogVersion: "fixture-catalog",
      modelVersion: "fixture-model",
      rendererHash: "b".repeat(64),
    },
  };
}

function candidate(
  fontId: string,
  rawPixelRank: number,
  rawPixelScore: number,
  confidence = 0,
): RankedFontCandidateV2 {
  return {
    rank: rawPixelRank,
    rawPixelRank,
    rawPixelScore,
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
    totalScore: rawPixelScore,
    confidence,
    reasonCodes: ["fixture", "supervised_top3_acceptability_rerank"],
  };
}
