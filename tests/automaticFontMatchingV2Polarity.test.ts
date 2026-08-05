import { describe, expect, it } from "vitest";
import {
  resolveAutomaticInverseTextStyle,
  type AutomaticInverseTextStyleV1,
} from "../src/main/pipeline/automaticFontMatchingV2Polarity";
import { applyAutomaticFontDecisionV2 } from "../src/main/pipeline/automaticFontMatchingV2Apply";
import type { AutomaticFontDecisionV2 } from "../src/main/pipeline/automaticFontMatchingV2";
import {
  FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION,
  type FontMatchingGlyphMorphologyV1,
} from "../src/main/pipeline/fontMatchingPagePixelPreprocessing";
import type { TranslationBlock } from "../src/shared/textTypes";
import { clearAutomaticFontMatchForManualStylePatch } from "../src/renderer/src/lib/automaticFontMatchProvenance";

const COLOR_PRESERVATION_CASES: ReadonlyArray<
  readonly [string, Partial<FontMatchingGlyphMorphologyV1>]
> = [
  ["ordinary dark-on-light", { foregroundPolarity: "dark" }],
  ["dim foreground", { foregroundMeanLuma: 209 }],
  ["bright background", { backgroundMeanLuma: 71 }],
  ["weak contrast", { foregroundMeanLuma: 215, backgroundMeanLuma: 66 }],
  ["ambiguous foreground area", { foregroundPixelCount: 4_501 }],
  ["single broad region", { connectedComponentCount: 1 }],
  ["fragmented noise", { connectedComponentCount: 129 }],
  ["sparse linework", { medianComponentFill: 0.179 }],
];

describe("automatic inverse text polarity", () => {
  it("selects off-white text and a dark outline only for a strong light-on-dark crop", () => {
    expect(resolveAutomaticInverseTextStyle(makeMorphology())).toEqual({
      source: "pixel_glyph_morphology_v1",
      textColor: "#f7f7f2",
      outlineColor: "#141414",
    });
  });

  it.each(COLOR_PRESERVATION_CASES)(
    "preserves colors for %s",
    (_label, overrides) => {
      expect(
        resolveAutomaticInverseTextStyle(makeMorphology(overrides)),
      ).toBeUndefined();
    },
  );

  it("preserves normal colors, but records and overrides inverse colors on apply", () => {
    const block = makeBlock();
    const normal = applyAutomaticFontDecisionV2(block, makeDecision());
    expect(normal.textColor).toBe("#234567");
    expect(normal.outlineColor).toBe("#abcdef");
    expect(normal.automaticFontMatch?.previousStyle).not.toHaveProperty(
      "textColor",
    );

    const inverse = applyAutomaticFontDecisionV2(
      block,
      makeDecision(resolveAutomaticInverseTextStyle(makeMorphology())),
    );
    expect(inverse.textColor).toBe("#f7f7f2");
    expect(inverse.outlineColor).toBe("#141414");
    expect(inverse.automaticFontMatch?.previousStyle).toMatchObject({
      textColor: "#234567",
      outlineColor: "#abcdef",
    });
  });

  it("keeps the first pre-automatic style across repeated automatic decisions", () => {
    const first = applyAutomaticFontDecisionV2(
      makeBlock(),
      makeDecision(resolveAutomaticInverseTextStyle(makeMorphology())),
    );
    const second = applyAutomaticFontDecisionV2(
      first,
      makeDecision(undefined, "jua"),
    );

    expect(second).toMatchObject({
      fontFamily: "jua",
      textColor: "#f7f7f2",
      outlineColor: "#141414",
    });
    expect(second.automaticFontMatch?.previousStyle).toEqual({
      fontFamily: "nanum-gothic",
      bold: false,
      italic: true,
      outlineWidthScale: 1.25,
      textColor: "#234567",
      outlineColor: "#abcdef",
    });
  });

  it("preserves the semantic role while provenance records the pixel-only role", () => {
    const applied = applyAutomaticFontDecisionV2(
      {
        ...makeBlock(),
        fontRole: "sign_ui_title",
        fontRoleConfidence: 0.97,
      },
      makeDecision(undefined, "dohyeon"),
    );

    expect(applied).toMatchObject({
      fontFamily: "dohyeon",
      fontRole: "sign_ui_title",
      fontRoleConfidence: 0.97,
    });
    expect(applied.automaticFontMatch).toMatchObject({
      selectedFontId: "dohyeon",
      role: "dialogue",
    });
  });

  it("preserves a zero-width automatic outline without forcing a minimum", () => {
    const applied = applyAutomaticFontDecisionV2(
      { ...makeBlock(), outlineWidthScale: 0 },
      makeDecision(
        resolveAutomaticInverseTextStyle(makeMorphology()),
        "dohyeon",
        0,
      ),
    );

    expect(applied).toMatchObject({
      fontFamily: "dohyeon",
      outlineWidthScale: 0,
      textColor: "#f7f7f2",
      outlineColor: "#141414",
    });
    expect(applied.automaticFontMatch?.previousStyle.outlineWidthScale).toBe(0);
  });

  it("clears automatic provenance for manual color changes only", () => {
    const automatic = applyAutomaticFontDecisionV2(
      makeBlock(),
      makeDecision(resolveAutomaticInverseTextStyle(makeMorphology())),
    );

    expect(
      clearAutomaticFontMatchForManualStylePatch(automatic, {
        textColor: "#fedcba",
      }),
    ).toEqual({ textColor: "#fedcba", automaticFontMatch: undefined });
    expect(
      clearAutomaticFontMatchForManualStylePatch(automatic, {
        translatedText: "수동 번역",
      }),
    ).toEqual({ translatedText: "수동 번역" });
  });
});

function makeMorphology(
  overrides: Partial<FontMatchingGlyphMorphologyV1> = {},
): FontMatchingGlyphMorphologyV1 {
  return {
    contractVersion: FONT_MATCHING_GLYPH_MORPHOLOGY_CONTRACT_VERSION,
    maskSource: "raw_grayscale_otsu_minority_area3",
    distanceTransform: "opencv_dist_l2_mask5",
    connectivity: 8,
    maskWidth: 100,
    maskHeight: 100,
    otsuThreshold: 124,
    foregroundPolarity: "light",
    foregroundPixelCount: 2_000,
    connectedComponentCount: 16,
    globalForegroundDistanceMean: 1.9,
    medianComponentDistanceMean: 1.8,
    medianComponentFill: 0.6,
    foregroundMeanLuma: 235,
    backgroundMeanLuma: 14,
    ...overrides,
  };
}

function makeDecision(
  inverseTextStyle?: AutomaticInverseTextStyleV1,
  fontId = "dohyeon",
  outlineWidthScale = 2,
): AutomaticFontDecisionV2 {
  return {
    result: {
      decision: {
        mode: "apply",
        selectedFontId: fontId,
        topCandidateFontIds: [fontId],
        noneAcceptable: false,
        abstainReason: null,
        resolvedBy: "v2_automatic",
      },
      selectedStyle: {
        fontId,
        fontWeight: 700,
        italic: false,
        outlineWidthScale,
      },
      audit: {
        policyVersion: "font-matching-decision-v2.0",
        legacyTitleOrRegexFallbackUsed: false,
        modelReportedNoneAcceptable: false,
        localCalibratedConfidence: 0.93,
        roleConfidence: 0.92,
        genreContributionCap: 0,
        evaluatedCandidates: [],
        rejectedCandidates: [],
        priorityTrace: [],
      },
    },
    role: { primary: "dialogue", confidence: 0.92, alternatives: [] },
    ...(inverseTextStyle ? { inverseTextStyle } : {}),
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: "白い文字",
    translatedText: "흰 글자",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontFamily: "nanum-gothic",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#234567",
    outlineColor: "#abcdef",
    outlineWidthScale: 1.25,
    bold: false,
    italic: true,
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
