import { describe, expect, it } from "vitest";
import {
  resolveAutomaticFontEmphasisStyle,
  resolveAutomaticFontPageWeightBaseline,
} from "../src/main/pipeline/automaticFontMatchingV2Emphasis";
import type { FontMatchingSourceStyleV2 } from "../src/shared/fontMatchingProfileTypes";

function makeSourceStyle(
  overrides: Partial<FontMatchingSourceStyleV2> = {},
): FontMatchingSourceStyleV2 {
  return {
    weight: 0.58,
    width: 0.5,
    serifness: 0.1,
    roundness: 0.5,
    strokeContrast: 0.2,
    handwritten: 0.1,
    angularity: 0.3,
    irregularity: 0.1,
    slant: 0.1,
    energy: 0.3,
    unknownFields: [],
    ...overrides,
  };
}

describe("automatic font emphasis policy", () => {
  it("uses the lower-60% median of valid cluster weights as the baseline", () => {
    const baseline = resolveAutomaticFontPageWeightBaseline([
      makeSourceStyle({ weight: 0.48 }),
      makeSourceStyle({ weight: 0.6 }),
      makeSourceStyle({ weight: 0.58, unknownFields: ["weight"] }),
      makeSourceStyle({ weight: 0.64 }),
    ]);

    expect(baseline).toBe(0.54);
    expect(
      resolveAutomaticFontPageWeightBaseline([makeSourceStyle()]),
    ).toBeNull();
  });

  it("separates normal, emphasized, and extra-bold text relative to the page", () => {
    const normal = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.63 }),
      treatment: { outline: "none" },
      pageBaselineWeight: 0.58,
      pageBaselineSampleCount: 5,
    });
    const emphasized = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.67 }),
      treatment: { outline: "none" },
      pageBaselineWeight: 0.58,
      pageBaselineSampleCount: 5,
    });
    const extraBold = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.75 }),
      treatment: { outline: "none" },
      pageBaselineWeight: 0.58,
      pageBaselineSampleCount: 5,
    });

    expect(normal.style.fontWeight).toBe(400);
    expect(emphasized.style.fontWeight).toBe(700);
    expect(emphasized.reasonCodes).toContain("page_relative_weight_emphasis");
    expect(extraBold.style.fontWeight).toBe(800);
  });

  it("falls back to the absolute gate when no page baseline is available", () => {
    const resolution = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.82 }),
      treatment: { outline: "unknown" },
    });

    expect(resolution.emphasisThreshold).toBe(0.78);
    expect(resolution.style).toEqual({ fontWeight: 700 });
    expect(resolution.reasonCodes).toContain("absolute_weight_emphasis");
  });

  it("does not call an absolutely heavy sample emphasized on an equally heavy page", () => {
    const resolution = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.86 }),
      treatment: { outline: "unknown" },
      pageBaselineWeight: 0.8,
      pageBaselineSampleCount: 4,
    });

    expect(resolution.emphasisThreshold).toBe(0.88);
    expect(resolution.style.fontWeight).toBe(400);
  });

  it.each([
    ["none", 0.5],
    ["single", 1],
    ["multiple", 1.75],
  ] as const)(
    "maps %s source outlines without changing family",
    (outline, expectedScale) => {
      const resolution = resolveAutomaticFontEmphasisStyle({
        sourceStyle: makeSourceStyle({ weight: 0.58 }),
        treatment: { outline },
        pageBaselineWeight: 0.58,
      });

      expect(resolution.style.outlineWidthScale).toBe(expectedScale);
      if (outline === "none") {
        expect(resolution.reasonCodes).toContain(
          "automatic_minimum_outline_preserved",
        );
      }
    },
  );

  it("does not use energy as emphasis or family evidence", () => {
    const calm = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.6, energy: 0.05 }),
      treatment: { outline: "unknown" },
      pageBaselineWeight: 0.58,
    });
    const energetic = resolveAutomaticFontEmphasisStyle({
      sourceStyle: makeSourceStyle({ weight: 0.6, energy: 0.99 }),
      treatment: { outline: "unknown" },
      pageBaselineWeight: 0.58,
    });

    expect(energetic).toEqual(calm);
  });
});
