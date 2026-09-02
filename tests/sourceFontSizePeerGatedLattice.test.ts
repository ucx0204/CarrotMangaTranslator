import { describe, expect, it } from "vitest";
import { refinePageSourceFontSizeHypotheses } from "../src/main/pipeline/sourceFontSizePeerGatedLattice";
import type {
  SourceFontSizeHypothesisCandidate,
  SourceFontSizeHypothesisTrial,
} from "../src/main/pipeline/sourceFontSizePeerGatedTypes";
import type { SourceFontSizeEstimate } from "../src/main/pipeline/sourceFontSizeGeometryTypes";

describe("page peer-gated source font-size lattice", () => {
  it("lowers only a structurally suspect high estimate with repeated own evidence", () => {
    const peers = [
      stableCandidate(22),
      stableCandidate(22),
      stableCandidate(22),
    ];
    const outlier = suspectHighCandidate(34, 24);

    const refined = refinePageSourceFontSizeHypotheses([...peers, outlier]);

    expect(refined.slice(0, 3).map((item) => item.facePx)).toEqual([
      22, 22, 22,
    ]);
    expect(refined[3]?.facePx).toBeCloseTo(24, 5);
    expect(refined[3]?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("does not correct without three independently stable page peers", () => {
    const refined = refinePageSourceFontSizeHypotheses([
      stableCandidate(22),
      stableCandidate(22),
      suspectHighCandidate(34, 24),
    ]);

    expect(refined.map((item) => item.facePx)).toEqual([22, 22, 34]);
  });

  it("preserves deliberate hierarchy when the candidate geometry agrees", () => {
    const refined = refinePageSourceFontSizeHypotheses([
      stableCandidate(22),
      stableCandidate(22),
      stableCandidate(22),
      stableCandidate(40),
      stableCandidate(14),
    ]);

    expect(refined.map((item) => item.facePx)).toEqual([22, 22, 22, 40, 14]);
  });

  it("raises a low projection only from repeated own geometry behind a peer gate", () => {
    const peers = [
      stableCandidate(21),
      stableCandidate(21),
      stableCandidate(21),
    ];
    const refined = refinePageSourceFontSizeHypotheses([
      ...peers,
      suspectLowCandidate(18.4, 21.2),
    ]);

    expect(refined.slice(0, 3).map((item) => item.facePx)).toEqual([
      21, 21, 21,
    ]);
    expect(refined[3]?.facePx).toBeGreaterThan(20);
    expect(refined[3]?.facePx).toBeLessThan(22);
  });

  it("does not inflate a genuinely small candidate without its own larger mode", () => {
    const peers = [
      stableCandidate(22),
      stableCandidate(22),
      stableCandidate(22),
    ];
    const refined = refinePageSourceFontSizeHypotheses([
      ...peers,
      suspectLowCandidate(14, 14),
    ]);

    expect(refined[3]?.facePx).toBe(14);
  });
});

function stableCandidate(facePx: number): SourceFontSizeHypothesisCandidate {
  const formulaLineCount = 2;
  const formulaTrial = trial(formulaLineCount, {
    componentFace: facePx,
    majorFaces: [facePx * 0.99, facePx * 1.01],
    projectionFace: facePx,
  });
  return candidate(facePx, formulaLineCount, new Map([[2, formulaTrial]]));
}

function suspectHighCandidate(
  baselineFace: number,
  repeatedFace: number,
): SourceFontSizeHypothesisCandidate {
  const formulaLineCount = 2;
  const trials = new Map<number, SourceFontSizeHypothesisTrial>([
    [
      1,
      trial(1, {
        componentFace: repeatedFace,
        majorFaces: [repeatedFace * 0.98, repeatedFace * 1.01],
        projectionFace: repeatedFace,
      }),
    ],
    [
      2,
      trial(2, {
        componentFace: repeatedFace,
        majorFaces: [baselineFace],
        projectionFace: baselineFace,
      }),
    ],
    [
      3,
      trial(3, {
        componentFace: repeatedFace,
        majorFaces: [repeatedFace * 0.99, repeatedFace * 1.02],
        projectionFace: repeatedFace,
      }),
    ],
    [
      4,
      trial(4, {
        componentFace: repeatedFace,
        majorFaces: [repeatedFace],
        projectionFace: repeatedFace,
      }),
    ],
  ]);
  return candidate(baselineFace, formulaLineCount, trials);
}

function suspectLowCandidate(
  baselineFace: number,
  repeatedFace: number,
): SourceFontSizeHypothesisCandidate {
  const formulaLineCount = 3;
  const trials = new Map<number, SourceFontSizeHypothesisTrial>([
    [
      2,
      trial(2, {
        componentFace: repeatedFace * 1.5,
        majorFaces: [repeatedFace * 0.98, repeatedFace * 1.03],
        projectionFace: repeatedFace * 1.15,
      }),
    ],
    [
      3,
      trial(3, {
        componentFace: repeatedFace * 1.45,
        majorFaces: [repeatedFace * 0.99, repeatedFace * 1.02],
        projectionFace: baselineFace,
      }),
    ],
    [
      4,
      trial(4, {
        componentFace: repeatedFace * 1.1,
        majorFaces: [repeatedFace, repeatedFace * 1.01],
        projectionFace: baselineFace * 0.95,
      }),
    ],
    [
      5,
      trial(5, {
        componentFace: repeatedFace,
        majorFaces: [repeatedFace * 0.99, repeatedFace * 1.02],
        projectionFace: baselineFace * 0.9,
      }),
    ],
  ]);
  return {
    ...candidate(baselineFace, formulaLineCount, trials),
    bboxCross: 120,
    glyphCount: 22,
  };
}

function candidate(
  facePx: number,
  formulaLineCount: number,
  trials: ReadonlyMap<number, SourceFontSizeHypothesisTrial>,
): SourceFontSizeHypothesisCandidate {
  return {
    baseline: estimate(facePx, 0.82),
    bboxCross: facePx * formulaLineCount * 1.8,
    formulaLineCount,
    glyphCount: 12,
    trialAt: (lineCount) => trials.get(lineCount) ?? null,
  };
}

function trial(
  lineCount: number,
  values: {
    componentFace: number;
    majorFaces: readonly number[];
    projectionFace: number;
  },
): SourceFontSizeHypothesisTrial {
  const scale = 1.02;
  return {
    component: {
      componentCount: 12,
      confidence: 0.82,
      lineCount,
      primaryFace: values.componentFace / scale,
      primaryMassShare: 0.5,
    },
    lineCount,
    majorPitch: {
      bandFaces: values.majorFaces.map((face) => face / scale),
      confidence: 0.8,
      face: Math.max(...values.majorFaces) / scale,
      lineCount,
    },
    projection: estimate(values.projectionFace, 0.8),
  };
}

function estimate(facePx: number, confidence: number): SourceFontSizeEstimate {
  return { confidence, facePx, method: "raster-core-v1" };
}
