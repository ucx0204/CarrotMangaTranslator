import { describe, expect, it } from "vitest";
import type {
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
} from "../src/shared/fontMatchingProfileTypes";
import {
  applyFontMatchingPageRelativePeerScorePreference,
  buildFontMatchingPageRelativeRoleQaPlan,
  projectFontMatchingPageRelativeRole,
  shouldRevertPageRelativeQaForApplyRate,
  type FontMatchingPageRelativeRoleQaInputRow,
} from "../src/main/pipeline/fontMatchingPageRelativeRoleQa";
import {
  maskIneligiblePixelCandidateScores,
  resolvePixelCandidateEligibility,
} from "../src/main/pipeline/fontMatchingPixelCandidateEligibility";

const FONT_IDS = ["nanum-gothic", "dohyeon", "gaegu", "single-day"] as const;

describe("opt-in page-relative role QA policy", () => {
  it("routes a repeated thin vertical ordinary cluster through the body head", () => {
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      ordinaryRow(`ordinary-${index}`, index),
    );

    const plan = buildFontMatchingPageRelativeRoleQaPlan(rows);

    for (const row of rows) {
      const projected = plan.get(row.blockId);
      expect(projected).toMatchObject({
        applied: true,
        originalRole: "emphasis_dialogue",
        projectedRole: "dialogue",
        routeFamily: "body",
        sourceGeometryDirection: row.sourceGeometryDirection,
        clusterBodyAnchorFontId: "nanum-gothic",
      });
      expect(
        projectFontMatchingPageRelativeRole(row.pixelRole, projected),
      ).toMatchObject({
        primary: "dialogue",
        confidence: row.pixelRole.confidence,
      });
    }
  });

  it("preserves a strong variant when the body head does not corroborate it", () => {
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      ordinaryRow(`mixed-${index}`, index),
    );
    rows[2] = {
      ...rows[2],
      bodyScores: Float32Array.from([1, 0.9, 0.8, -2]),
      variantScores: Float32Array.from([0, 5, 0.2, -2]),
      baselineSelectedFontId: "dohyeon",
    };

    const plan = buildFontMatchingPageRelativeRoleQaPlan(rows);

    expect(plan.get("mixed-2")).toMatchObject({
      applied: false,
      projectedRole: "emphasis_dialogue",
      routeFamily: "variant",
      reasonCodes: ["preserve_strong_local_variant_pixel_gap"],
    });
    expect(plan.get("mixed-0")?.projectedRole).toBe("dialogue");
  });

  it("does not self-anchor a uniformly heavy all-emphasis cluster", () => {
    const rows = Array.from({ length: 4 }, (_unused, index) => ({
      ...ordinaryRow(`heavy-${index}`, index),
      glyphMorphology: morphology({
        globalForegroundDistanceMean: 2.2,
        medianComponentDistanceMean: 1.9,
        foregroundMeanLuma: 35,
      }),
    }));

    const plan = buildFontMatchingPageRelativeRoleQaPlan(rows);

    expect([...plan.values()].every((row) => !row.applied)).toBe(true);
  });

  it("ranks the nearby page-8 fragment peer above Single Day without changing eligibility", () => {
    const subject = fragmentRow({
      blockId: "page-8-saka",
      bbox: { x: 100, y: 100, w: 50, h: 55 },
      variantScores: [0, 0.2, 3, 4],
      baselineSelectedFontId: "single-day",
    });
    const peer = fragmentRow({
      blockId: "page-8-seka",
      bbox: { x: 148, y: 104, w: 55, h: 56 },
      variantScores: [0, 4, 3, 0],
      baselineSelectedFontId: "gaegu",
    });

    const plan = buildFontMatchingPageRelativeRoleQaPlan([subject, peer]);
    const subjectPlan = plan.get(subject.blockId);
    const eligibility = resolvePixelCandidateEligibility(
      FONT_IDS,
      subject.variantScores,
      subject.pixelRole,
    );
    const reranked = applyFontMatchingPageRelativePeerScorePreference(
      FONT_IDS,
      eligibility.scores,
      eligibility.eligibleMask,
      subjectPlan,
    );

    expect(subjectPlan).toMatchObject({
      applied: true,
      projectedRole: "emphasis_dialogue",
      routeFamily: "variant",
      preferredPeerFontId: "gaegu",
      peerBlockId: "page-8-seka",
      reasonCodes: ["split_fragment_peer_rank"],
    });
    expect(eligibility.scores[FONT_IDS.indexOf("single-day")]).toBe(
      subject.variantScores[FONT_IDS.indexOf("single-day")],
    );
    expect(reranked[FONT_IDS.indexOf("gaegu")]).toBeGreaterThan(
      reranked[FONT_IDS.indexOf("single-day")] ?? Infinity,
    );
  });

  it("preserves the isolated page-9 breath and its Single Day score", () => {
    const breath = fragmentRow({
      blockId: "page-9-breath",
      bbox: { x: 300, y: 200, w: 33, h: 63 },
      variantScores: [0, 0.2, 2, 4],
      baselineSelectedFontId: "single-day",
    });

    const plan = buildFontMatchingPageRelativeRoleQaPlan([breath]);
    const breathPlan = plan.get(breath.blockId);
    const eligible = maskIneligiblePixelCandidateScores(
      FONT_IDS,
      breath.variantScores,
      breath.pixelRole,
    );

    expect(breathPlan).toMatchObject({
      applied: false,
      projectedRole: "emphasis_dialogue",
      preferredPeerFontId: null,
      reasonCodes: ["preserve_isolated_single_day_variant"],
    });
    expect(
      applyFontMatchingPageRelativePeerScorePreference(
        FONT_IDS,
        eligible,
        new Uint8Array(FONT_IDS.length).fill(1),
        breathPlan,
      ),
    ).toEqual(eligible);
    expect(eligible.indexOf(Math.max(...eligible))).toBe(
      FONT_IDS.indexOf("single-day"),
    );
  });

  it("never revives a forbidden Single Day candidate through a peer preference", () => {
    const dialogue = prediction("dialogue", 0.99);
    const eligibility = resolvePixelCandidateEligibility(
      FONT_IDS,
      Float32Array.from([0, 0.2, 0.4, 8]),
      dialogue,
    );
    const forbiddenIndex = FONT_IDS.indexOf("single-day");
    const forbiddenPlan = {
      blockId: "forbidden-single-day",
      originalRole: "dialogue" as const,
      projectedRole: "dialogue" as const,
      routeFamily: "body" as const,
      sourceGeometryDirection: directionEvidence("vertical"),
      clusterId: null,
      clusterBodyAnchorFontId: null,
      preferredPeerFontId: "single-day",
      peerBlockId: "bad-peer",
      reasonCodes: ["synthetic_forbidden_peer"],
      applied: true,
    };

    const reranked = applyFontMatchingPageRelativePeerScorePreference(
      FONT_IDS,
      eligibility.scores,
      eligibility.eligibleMask,
      forbiddenPlan,
    );

    expect(eligibility.eligibleMask[forbiddenIndex]).toBe(0);
    expect(reranked).toEqual(eligibility.scores);
    expect(reranked.indexOf(Math.max(...reranked))).not.toBe(forbiddenIndex);
  });

  it("does not pair fragments whose OCR geometry directions differ", () => {
    const subject = fragmentRow({
      blockId: "vertical-directionless",
      bbox: { x: 100, y: 100, w: 50, h: 55 },
      variantScores: [0, 0.2, 3, 4],
      baselineSelectedFontId: "single-day",
    });
    const peer = fragmentRow({
      blockId: "horizontal-directionless",
      bbox: { x: 148, y: 104, w: 55, h: 56 },
      variantScores: [0, 4, 3, 0],
      baselineSelectedFontId: "gaegu",
    });
    const rows = [
      {
        ...subject,
        sourceGeometryDirection: directionEvidence("vertical"),
      },
      {
        ...peer,
        sourceGeometryDirection: directionEvidence("horizontal"),
      },
    ];

    const plan = buildFontMatchingPageRelativeRoleQaPlan(rows);

    expect(plan.get(subject.blockId)).toMatchObject({
      applied: false,
      preferredPeerFontId: null,
      peerBlockId: null,
      reasonCodes: ["preserve_isolated_single_day_variant"],
    });
  });

  it("ignores conflicting model and treatment directions and pairs by OCR geometry", () => {
    const subject = withLegacyModelDirection(
      fragmentRow({
        blockId: "legacy-horizontal-subject",
        bbox: { x: 100, y: 100, w: 50, h: 55 },
        variantScores: [0, 0.2, 3, 4],
        baselineSelectedFontId: "single-day",
      }),
      "horizontal",
    );
    const peer = withLegacyModelDirection(
      fragmentRow({
        blockId: "legacy-vertical-peer",
        bbox: { x: 148, y: 104, w: 55, h: 56 },
        variantScores: [0, 4, 3, 0],
        baselineSelectedFontId: "gaegu",
      }),
      "vertical",
    );

    const plan = buildFontMatchingPageRelativeRoleQaPlan([subject, peer]);

    expect(plan.get(subject.blockId)).toMatchObject({
      applied: true,
      preferredPeerFontId: "gaegu",
      peerBlockId: peer.blockId,
      reasonCodes: ["split_fragment_peer_rank"],
    });
  });

  it("fails closed instead of falling back to model orientation", () => {
    const rows = Array.from({ length: 4 }, (_unused, index) => {
      const { sourceGeometryDirection: _omitted, ...row } = ordinaryRow(
        `missing-direction-${index}`,
        index,
      );
      return {
        ...row,
        treatment: { ...row.treatment, orientation: "vertical" as const },
      };
    });

    const plan = buildFontMatchingPageRelativeRoleQaPlan(rows);

    expect(
      [...plan.values()].every(
        (row) =>
          !row.applied &&
          row.clusterId === null &&
          row.sourceGeometryDirection === null,
      ),
    ).toBe(true);
  });

  it("rejects direction evidence not bound to the enclosing worker item", () => {
    const rows = Array.from({ length: 4 }, (_unused, index) => {
      const row = ordinaryRow(`membership-mismatch-${index}`, index);
      const evidence = row.sourceGeometryDirection;
      if (!evidence) throw new Error("missing test direction evidence");
      return {
        ...row,
        sourceGeometryDirection: {
          ...evidence,
          candidateMembership: {
            ...evidence.candidateMembership,
            originalCandidateIds: [999],
          },
        },
      };
    });

    const plan = buildFontMatchingPageRelativeRoleQaPlan(rows);

    expect(
      [...plan.values()].every(
        (row) =>
          !row.applied &&
          row.clusterId === null &&
          row.sourceGeometryDirection === null,
      ),
    ).toBe(true);
  });

  it("reverts only when the QA selector would drop an accepted baseline row", () => {
    expect(shouldRevertPageRelativeQaForApplyRate(true, false)).toBe(true);
    expect(shouldRevertPageRelativeQaForApplyRate(true, true)).toBe(false);
    expect(shouldRevertPageRelativeQaForApplyRate(false, false)).toBe(false);
    expect(shouldRevertPageRelativeQaForApplyRate(false, true)).toBe(false);
  });
});

describe("library QA opt-in flag", () => {
  type Harness = {
    parseArguments: (values: string[]) => {
      command: string;
      options: Record<string, unknown>;
    };
    resolveQaPageRelativeRoleReroute: (
      options: Record<string, unknown>,
      cacheMode: "off" | "required",
    ) => boolean;
  };
  const harness =
    require("../scripts/run-library-full-pipeline-qa.cjs") as Harness;

  it("defaults off, requires the explicit flag, and rejects sealed inference reuse", () => {
    const omitted = harness.parseArguments(["run"]);
    const enabled = harness.parseArguments([
      "run",
      "--qa-page-relative-role-reroute",
    ]);

    expect(
      harness.resolveQaPageRelativeRoleReroute(omitted.options, "off"),
    ).toBe(false);
    expect(
      harness.resolveQaPageRelativeRoleReroute(enabled.options, "off"),
    ).toBe(true);
    expect(() =>
      harness.resolveQaPageRelativeRoleReroute(enabled.options, "required"),
    ).toThrow("requires live font inference");
  });
});

function ordinaryRow(
  blockId: string,
  index: number,
): FontMatchingPageRelativeRoleQaInputRow {
  const firstCandidateId = index * 2 + 1;
  const candidateIds = [firstCandidateId, firstCandidateId + 1];
  const sourceGeometryDirection = directionEvidence(
    "vertical",
    [firstCandidateId],
    candidateIds,
  );
  return {
    blockId,
    item: {
      id: firstCandidateId,
      bbox: { x: 100 + index * 100, y: 100, w: 80, h: 180 },
      candidateIds,
    },
    pixelRole: prediction("emphasis_dialogue", 0.96),
    dialogueProbability: 0.12,
    emphasisProbability: 0.96,
    glyphMorphology: morphology({
      globalForegroundDistanceMean: 1.5 + index * 0.005,
      medianComponentDistanceMean: 1.45 + index * 0.005,
      foregroundMeanLuma: 55 + index * 0.2,
    }),
    sourceGeometryDirection,
    sourceCandidateMembership: sourceGeometryDirection.candidateMembership,
    treatment: { distortion: "none", orientation: "vertical" },
    candidateIds: FONT_IDS,
    bodyScores: Float32Array.from([5, 0.2, 0, -2]),
    variantScores: Float32Array.from([0, 5, 0.2, -2]),
    temperature: 1,
    baselineCalibrationApplied: true,
    baselineSelectedFontId: "nanum-gothic",
  };
}

function fragmentRow({
  blockId,
  bbox,
  variantScores,
  baselineSelectedFontId,
}: {
  blockId: string;
  bbox: { x: number; y: number; w: number; h: number };
  variantScores: readonly number[];
  baselineSelectedFontId: string;
}): FontMatchingPageRelativeRoleQaInputRow {
  const sourceGeometryDirection = directionEvidence("vertical");
  return {
    blockId,
    item: { id: 1, bbox, candidateIds: [1] },
    pixelRole: prediction("emphasis_dialogue", 0.95),
    dialogueProbability: 0.04,
    emphasisProbability: 0.95,
    glyphMorphology: morphology({
      globalForegroundDistanceMean: 1.6,
      medianComponentDistanceMean: 1.5,
      foregroundMeanLuma: 53,
      connectedComponentCount: 6,
    }),
    sourceGeometryDirection,
    sourceCandidateMembership: sourceGeometryDirection.candidateMembership,
    treatment: { distortion: "none", orientation: "vertical" },
    candidateIds: FONT_IDS,
    bodyScores: Float32Array.from([4, 0, 0.2, -1]),
    variantScores: Float32Array.from(variantScores),
    temperature: 1,
    baselineCalibrationApplied: true,
    baselineSelectedFontId,
  };
}

function withLegacyModelDirection(
  row: FontMatchingPageRelativeRoleQaInputRow,
  direction: "horizontal" | "vertical",
): FontMatchingPageRelativeRoleQaInputRow {
  return {
    ...row,
    item: row.item ? { ...row.item, direction } : undefined,
  } as FontMatchingPageRelativeRoleQaInputRow;
}

function directionEvidence(
  direction: "horizontal" | "vertical",
  candidateIds: readonly number[] = [1],
  originalCandidateIds: readonly number[] = candidateIds,
) {
  return {
    contractVersion: "font-matching-ocr-geometry-direction-v2" as const,
    source: "semantic_ocr_candidate_bbox_majority" as const,
    direction,
    candidateIds,
    candidateMembership: {
      contractVersion: "font-matching-ocr-candidate-membership-v2" as const,
      source: "sealed_font_input_request_block_v2" as const,
      bindingId: `block-${originalCandidateIds.join("-")}`,
      originalCandidateIds,
      voterCandidateIds: candidateIds,
    },
  };
}

function prediction(
  primary: FontMatchingSemanticRole,
  confidence: number,
): FontMatchRolePredictionV2 {
  return {
    primary,
    confidence,
    alternatives: [{ role: "dialogue", confidence: 0.12 }],
  };
}

function morphology(
  overrides: Partial<
    NonNullable<FontMatchingPageRelativeRoleQaInputRow["glyphMorphology"]>
  > = {},
): NonNullable<FontMatchingPageRelativeRoleQaInputRow["glyphMorphology"]> {
  return {
    contractVersion: "font-matching-glyph-morphology-v1",
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    maskWidth: 80,
    maskHeight: 180,
    otsuThreshold: 120,
    foregroundPolarity: "dark",
    foregroundPixelCount: 500,
    connectedComponentCount: 12,
    globalForegroundDistanceMean: 1.5,
    medianComponentDistanceMean: 1.45,
    medianComponentFill: 0.5,
    foregroundMeanLuma: 55,
    backgroundMeanLuma: 245,
    ...overrides,
  };
}
