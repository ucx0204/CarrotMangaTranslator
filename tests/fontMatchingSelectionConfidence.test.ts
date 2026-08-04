import { describe, expect, it } from "vitest";
import type { RankedFontCandidateV2 } from "../src/shared/fontMatchingProfileTypes";
import {
  applyReleaseCalibratedSelectionConfidence,
  requireSelectionRoleFamilyAgreement,
} from "../src/main/pipeline/fontMatchingSelectionConfidence";

const RELEASE = {
  overallAcceptableAt1: 0.8362068965517241,
  ordinaryAcceptableAt1: 0.855072463768116,
  variantAcceptableAt1: 0.7704075002320616,
} as const;

describe("font selection confidence calibration", () => {
  it("uses held-out acceptability and independent style corroboration, not raw p1", () => {
    const lowSoftmax = calibrate([
      candidate("gaegu", 1, 0.09, 0.92),
      candidate("jua", 2, 0.089, 0.61),
      candidate("dohyeon", 3, 0.088, 0.58),
    ]);
    const highSoftmax = calibrate([
      candidate("gaegu", 1, 0.9, 0.92),
      candidate("jua", 2, 0.05, 0.61),
      candidate("dohyeon", 3, 0.04, 0.58),
    ]);

    expect(lowSoftmax[0]?.confidence).toBeGreaterThan(0.82);
    expect(lowSoftmax[0]?.confidence).toBeCloseTo(
      highSoftmax[0]?.confidence ?? 0,
      10,
    );
    expect(
      lowSoftmax.slice(1).every(({ confidence }) => confidence === 0),
    ).toBe(true);
  });

  it("abstains when the style head does not independently verify the winner", () => {
    const result = calibrate([
      candidate("gaegu", 1, 0.12, 0.75),
      candidate("jua", 2, 0.11, 0.74),
      candidate("dohyeon", 3, 0.1, 0.73),
    ]);

    expect(result[0]?.confidence).toBeLessThanOrEqual(0.79);
    expect(result[0]?.reasonCodes).toContain("release_calibrated_abstain");
  });

  it("invalidates the cohort estimate when pixel and LLM role families conflict", () => {
    const calibrated = calibrate([
      candidate("gaegu", 1, 0.09, 0.92),
      candidate("jua", 2, 0.089, 0.61),
      candidate("dohyeon", 3, 0.088, 0.58),
    ]);
    const conflicted = requireSelectionRoleFamilyAgreement(
      calibrated,
      "sfx_emotion",
      "dialogue",
    );

    expect(conflicted[0]?.confidence).toBe(0.79);
    expect(conflicted[0]?.reasonCodes).toContain(
      "pixel_llm_role_family_conflict",
    );
  });
});

function calibrate(
  rankedCandidates: readonly RankedFontCandidateV2[],
): RankedFontCandidateV2[] {
  return applyReleaseCalibratedSelectionConfidence({
    rankedCandidates,
    role: "sfx_emotion",
    noneProbability: 0.02,
    releaseMetrics: RELEASE,
  });
}

function candidate(
  fontId: string,
  rank: number,
  totalScore: number,
  styleFit: number,
): RankedFontCandidateV2 {
  return {
    rank,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit,
    roleFit: 0.9,
    layoutFit: null,
    glyphCoverage: null,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore,
    confidence: totalScore,
    reasonCodes: ["verified_pixel_model"],
  };
}
