import { describe, expect, it } from "vitest";
import { refinePageSourceFontSizeHypotheses } from "../src/main/pipeline/sourceFontSizePeerGatedLattice";
import { refineNarrowVerticalLineCountRecoveries } from "../src/main/pipeline/sourceFontSizePeerGatedUpward";
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

  it("recovers a narrow vertical one-column face from projection plus writing-axis pitch", () => {
    const peers = [stableCandidate(21.9496), stableCandidate(29.18)];
    const target = narrowVerticalCandidate();

    const refined = refinePageSourceFontSizeHypotheses([...peers, target]);

    expect(refined.slice(0, 2).map((item) => item.facePx)).toEqual([
      21.9496, 29.18,
    ]);
    expect(refined[2]?.facePx).toBeCloseTo(23.3858, 4);
    expect(refined[2]?.confidence).toBeCloseTo(0.6889, 4);
  });

  it("requires two nearby page peers without copying either peer value", () => {
    const target = narrowVerticalCandidate();
    const refined = refineNarrowVerticalLineCountRecoveries(
      [target, stableCandidate(22)],
      [target.baseline, estimate(22, 0.82)],
    );

    expect(refined[0]?.facePx).toBe(15.402);
  });

  it("preserves legitimate narrow-small and narrow-large hierarchy", () => {
    const peers = [stableCandidate(22), stableCandidate(24)];
    const genuineSmall = narrowVerticalCandidate({
      baselineConfidence: 0.82,
      baselineFace: 17.8,
    });
    const genuineLarge = narrowVerticalCandidate({
      baselineConfidence: 0.7,
      baselineFace: 112,
      bboxCross: 159,
      bboxMajor: 1216,
      formulaLineCount: 1,
    });
    const refined = refineNarrowVerticalLineCountRecoveries(
      [genuineSmall, genuineLarge, ...peers],
      [
        genuineSmall.baseline,
        genuineLarge.baseline,
        estimate(22, 0.82),
        estimate(24, 0.82),
      ],
    );

    expect(refined[0]?.facePx).toBe(17.8);
    expect(refined[1]?.facePx).toBe(112);
  });

  it.each([
    ["horizontal source", { direction: "horizontal" as const }],
    ["short glyph inventory", { glyphCount: 7 }],
    ["oversized glyph inventory", { glyphCount: 49 }],
    ["wide region", { bboxMajor: 120 }],
    ["too many formula columns", { formulaLineCount: 5 }],
    ["weak projection", { projectionConfidence: 0.79 }],
    ["missing projection", { projectionFace: null }],
    ["weak major pitch", { majorConfidence: 0.68 }],
    ["missing major pitch", { majorFace: null }],
    ["weak connected mass", { componentMassShare: 0.89 }],
    ["missing connected span", { componentFace: null }],
    ["projection/major disagreement", { majorFace: 17 }],
    ["connected span too short", { componentFace: 28 }],
    ["connected span too long", { componentFace: 60 }],
    ["uplift too small", { baselineFace: 19 }],
    ["uplift too large", { baselineFace: 12 }],
  ])("rejects %s", (_label, overrides) => {
    const target = narrowVerticalCandidate(overrides);
    const peers = [stableCandidate(22), stableCandidate(29)];
    const refined = refineNarrowVerticalLineCountRecoveries(
      [target, ...peers],
      [target.baseline, estimate(22, 0.82), estimate(29, 0.82)],
    );

    expect(refined[0]?.facePx).toBe(target.baseline.facePx);
  });

  it.each([
    ["above the peer tier", 18, 19],
    ["below the peer tier", 31.4, 31.5],
  ])("rejects a candidate-owned face %s", (_label, left, right) => {
    const target = narrowVerticalCandidate();
    const peers = [stableCandidate(left), stableCandidate(right)];
    const refined = refineNarrowVerticalLineCountRecoveries(
      [target, ...peers],
      [target.baseline, estimate(left, 0.82), estimate(right, 0.82)],
    );

    expect(refined[0]?.facePx).toBe(15.402);
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
    bboxMajor: facePx * 5,
    direction: "vertical",
    formulaLineCount,
    glyphCount: 12,
    trialAt: (lineCount) => trials.get(lineCount) ?? null,
  };
}

// eslint-disable-next-line complexity -- one fixture exposes every independent fail-closed gate
function narrowVerticalCandidate(
  overrides: {
    baselineConfidence?: number;
    baselineFace?: number;
    bboxCross?: number;
    bboxMajor?: number;
    componentFace?: number | null;
    componentMassShare?: number;
    direction?: "horizontal" | "vertical";
    formulaLineCount?: number;
    glyphCount?: number;
    majorConfidence?: number;
    majorFace?: number | null;
    projectionConfidence?: number;
    projectionFace?: number | null;
  } = {},
): SourceFontSizeHypothesisCandidate {
  const baselineFace = overrides.baselineFace ?? 15.402;
  const formulaLineCount = overrides.formulaLineCount ?? 2;
  const alternativeLineCount = formulaLineCount - 1;
  const componentFace = Object.hasOwn(overrides, "componentFace")
    ? (overrides.componentFace ?? null)
    : 44.88;
  const majorFace = Object.hasOwn(overrides, "majorFace")
    ? (overrides.majorFace ?? null)
    : 22.746;
  const projectionFace = Object.hasOwn(overrides, "projectionFace")
    ? (overrides.projectionFace ?? null)
    : 24.0435;
  const alternative: SourceFontSizeHypothesisTrial = {
    component:
      componentFace === null
        ? null
        : {
            componentCount: 9,
            confidence: 0.77,
            lineCount: alternativeLineCount,
            primaryFace: componentFace / 1.02,
            primaryMassShare: overrides.componentMassShare ?? 1,
          },
    lineCount: alternativeLineCount,
    majorPitch:
      majorFace === null
        ? null
        : {
            bandFaces: [majorFace / 1.02],
            confidence: overrides.majorConfidence ?? 0.6956,
            face: majorFace / 1.02,
            lineCount: alternativeLineCount,
          },
    projection:
      projectionFace === null
        ? null
        : estimate(projectionFace, overrides.projectionConfidence ?? 0.8096),
  };
  return {
    baseline: estimate(baselineFace, overrides.baselineConfidence ?? 0.6982),
    bboxCross: overrides.bboxCross ?? 57,
    bboxMajor: overrides.bboxMajor ?? 193,
    direction: overrides.direction ?? "vertical",
    formulaLineCount,
    glyphCount: overrides.glyphCount ?? 9,
    trialAt: (lineCount) =>
      lineCount === alternativeLineCount ? alternative : null,
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
