import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveAutomaticFontDecisionV2,
  resolveFontMatchingV2CatalogVersion,
} from "../src/main/pipeline/automaticFontMatchingV2";
import {
  applyCrossScriptProxyCandidateRanking,
  hasVerifiedCrossScriptProxyInference,
} from "../src/main/pipeline/automaticFontMatchingV2CrossScriptProxy";
import { applyAutomaticFontDecisionV2 } from "../src/main/pipeline/automaticFontMatchingV2Apply";
import { prepareAutomaticFontEvidence } from "../src/main/pipeline/automaticFontMatchingV2Evidence";
import { applyAutomaticPixelStyle } from "../src/main/pipeline/automaticFontMatchingV2Style";
import { buildFontMatchingSourceGlyphInput } from "../src/main/pipeline/fontMatchingCrossScriptProxyHints";
import { isCrossScriptProxyEligibleBlock } from "../src/main/pipeline/fontMatchingCrossScriptProxyPolicy";
import { selectCrossScriptProxyWeightFace } from "../src/main/pipeline/fontMatchingCrossScriptProxyRuntime";
import type { AutomaticFontDecisionV2 } from "../src/main/pipeline/automaticFontMatchingV2";
import type { FontMatchingDecisionResultV2 } from "../src/main/pipeline/fontMatchingDecisionV2";
import type { FontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";
import type {
  FontMatchingPageInferenceBlock,
  VerifiedAutomaticFontPixelInferenceV2,
} from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { RankedFontCandidateV2 } from "../src/shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { BUILT_IN_BLOCK_FONTS } from "../src/shared/blockFontCatalog";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
import {
  FONT_EXPRESSION_CONTRACT,
  FONT_EXPRESSION_MODEL_SHA256,
} from "../src/main/pipeline/fontMatchingExpressionTypes";
import {
  inferFontExpressionPage,
  loadFontExpressionModel,
} from "../src/main/pipeline/fontMatchingExpressionRuntime";
import expressionFixture from "./fixtures/fontExpressionParity.json";

describe("cross-script page font proxy", () => {
  it("adds native expression evidence without changing R33 or bypassing the proxy boundary", async () => {
    const candidates = makeCandidates();
    const row = makeInference(candidates);
    const skipped = { ...row, blockId: "skip", crossScriptProxy: undefined };
    const gray = Buffer.from(expressionFixture.grayBase64, "base64");
    const bgra = new Uint8Array(gray.length * 4);
    gray.forEach((value, i) => {
      bgra.fill(value, i * 4, i * 4 + 3);
      bgra[i * 4 + 3] = 255;
    });
    const block = makeInferenceBlock("dialogue");
    const session = await loadFontExpressionModel();
    try {
      const output = await inferFontExpressionPage({
        session,
        blocks: [
          {
            ...block,
            item: { ...block.item, bbox: { x: 0, y: 0, w: 1000, h: 1000 } },
          },
          { ...block, blockId: "skip" },
        ],
        rows: new Map([
          [row.blockId, row],
          [skipped.blockId, skipped],
        ]),
        raster: {
          width: expressionFixture.width,
          height: expressionFixture.height,
          bgra,
        },
      });
      expect(output.get("skip")).toBe(skipped);
      const added = output.get(row.blockId);
      expect(added?.localEvidence).toBe(row.localEvidence);
      expect(added?.crossScriptProxy).toBe(row.crossScriptProxy);
      expect(added?.sourceExpression).toMatchObject({
        modelSha256: FONT_EXPRESSION_MODEL_SHA256,
        componentCount: expressionFixture.components,
      });
      expect(
        added?.sourceExpression?.probabilities.reduce((a, b) => a + b, 0),
      ).toBeCloseTo(1, 8);
      expect(row.sourceExpression).toBeUndefined();
    } finally {
      await session.release();
    }
  });
  it("carries heavy rescue through real evidence, decision and style while keeping manual locks", () => {
    const candidates = [
      makeAutomaticFontCandidate({ fontId: "dohyeon" }),
      makeAutomaticFontCandidate({ fontId: "nanum-myeongjo", weight: 700 }),
    ];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const inference: VerifiedAutomaticFontPixelInferenceV2 = {
      ...makeRuntimeBoundInference(candidates, catalogVersion),
      sourceExpression: {
        contractVersion: FONT_EXPRESSION_CONTRACT,
        modelSha256: FONT_EXPRESSION_MODEL_SHA256,
        componentCount: 3,
        probabilities: [0.01, 0.01, 0.01, 0.95, 0.01, 0.01],
      },
    };
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock(),
      item: makeItem("dialogue"),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pixelInference: inference,
        runtimeArtifactStatus: makeRuntimeStatus(candidates, catalogVersion),
      },
    });
    expect(decision?.result.decision.selectedFontId).toBe("dohyeon");
    expect(decision?.result.selectedStyle).toEqual({
      fontId: "dohyeon",
      fontWeight: 400,
      italic: false,
    });
    const locked = makeDecisionResult("block_user_lock");
    expect(
      applyAutomaticPixelStyle({
        candidates,
        pixelInference: inference,
        result: locked,
        workState: undefined,
      }),
    ).toBe(locked);
    if (!decision) throw new Error("Missing automatic decision");
    expect(applyAutomaticFontDecisionV2(makeBlock(), decision)).toMatchObject({
      fontFamily: "dohyeon",
      bold: false,
      fontSizePx: 24,
      outlineWidthPx: 3.25,
      outlineWidthScale: 1.6,
    });
  });
  it("discards OCR character identity before the model boundary", () => {
    const input = buildFontMatchingSourceGlyphInput({
      item: makeItem("dialogue"),
      page: makePage(),
      rawHints: [
        { id: 1, x1: 10, y1: 20, x2: 80, y2: 40, ocrText: "秘密の台詞" },
      ],
      sourceGeometryDirection: {
        contractVersion: "font-matching-ocr-geometry-direction-v2",
        source: "semantic_ocr_candidate_bbox_majority",
        direction: "horizontal",
        candidateIds: [1],
        candidateMembership: {
          contractVersion: "font-matching-ocr-candidate-membership-v2",
          source: "semantic_ocr_fixed_block_request_v6",
          bindingId: "B001",
          originalCandidateIds: [1],
          voterCandidateIds: [1],
        },
      },
    });

    expect(input).toEqual({
      contractVersion: "font-matching-source-glyph-input-v1",
      source: "semantic_ocr_geometry_and_count_only",
      direction: "horizontal",
      lines: [{ x1: 10, y1: 20, x2: 80, y2: 40, glyphCount: 5 }],
      fallbackGlyphCount: 2,
    });
    expect(JSON.stringify(input)).not.toContain("秘密");
  });

  it("uses the verified visual ranking and its exact face style", () => {
    const candidates = makeCandidates();
    const inference = makeInference(candidates);
    const ranked = applyCrossScriptProxyCandidateRanking(
      candidates.map((candidate, index) => makeRanked(candidate.fontId, index)),
      candidates,
      inference,
    );

    expect(ranked?.map(({ fontId }) => fontId)).toEqual([
      "nanum-myeongjo",
      "nanum-gothic",
    ]);
    const styled = applyAutomaticPixelStyle({
      candidates,
      pixelInference: inference,
      result: makeDecisionResult("v2_automatic"),
      workState: undefined,
    });
    expect(styled.selectedStyle).toEqual({
      fontId: "nanum-myeongjo",
      fontWeight: 700,
      italic: true,
    });
  });

  it("feeds the verified proxy ordering through the production evidence boundary", () => {
    const candidates = makeCandidates();
    const inference = makeInference(candidates);
    const evidence = prepareAutomaticFontEvidence({
      block: makeBlock(),
      candidates,
      locale: "ko",
      pixelInference: inference,
      role: inference.rolePrediction,
      runtimePolicy: null,
      workState: undefined,
    });

    expect(evidence.rankedCandidates.map(({ fontId }) => fontId)).toEqual([
      "nanum-myeongjo",
      "nanum-gothic",
    ]);
    expect(evidence.rankedCandidates[0]?.reasonCodes).toContain(
      "cross_script_visual_voice_v1",
    );
  });

  it("uses proxy evidence even when the legacy selector abstains", () => {
    const candidates = makeCandidates();
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const inference = makeRuntimeBoundInference(candidates, catalogVersion);
    const decision = resolveAutomaticFontDecisionV2({
      block: makeBlock(),
      item: makeItem("dialogue"),
      page: makePage(),
      options: {
        enabled: true,
        targetLanguage: "ko",
        candidates,
        pixelInference: inference,
        runtimeArtifactStatus: makeRuntimeStatus(candidates, catalogVersion),
      },
    });

    expect(decision?.result.decision).toMatchObject({
      mode: "apply",
      selectedFontId: "nanum-myeongjo",
      noneAcceptable: false,
      resolvedBy: "v2_automatic",
    });
    expect(decision?.result.selectedStyle).toEqual({
      fontId: "nanum-myeongjo",
      fontWeight: 700,
      italic: true,
    });
  });

  it("keeps every production proxy output candidate Korean-only", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(
          __dirname,
          "..",
          "src",
          "main",
          "runtime",
          "font-matching-crossscript-proxy",
          "runtime-manifest.json",
        ),
        "utf8",
      ),
    ) as { candidates: Array<{ font_id: string }> };
    const localeById = new Map<string, string>(
      BUILT_IN_BLOCK_FONTS.map((font) => [font.id, font.locale]),
    );
    const outputFontIds = [
      ...new Set(manifest.candidates.map((candidate) => candidate.font_id)),
    ];

    expect(outputFontIds.length).toBeGreaterThan(0);
    expect(
      outputFontIds.every((fontId) => localeById.get(fontId) === "ko"),
    ).toBe(true);
    expect(
      outputFontIds.some((fontId) => localeById.get(fontId) === "ja"),
    ).toBe(false);
  });

  it("fails closed on a duplicate or incomplete candidate ranking", () => {
    const candidates = makeCandidates();
    const valid = makeInference(candidates);
    const invalid = {
      ...valid,
      crossScriptProxy: {
        ...valid.crossScriptProxy,
        candidates: [
          valid.crossScriptProxy?.candidates[0],
          valid.crossScriptProxy?.candidates[0],
        ],
      },
    } as VerifiedAutomaticFontPixelInferenceV2;

    expect(hasVerifiedCrossScriptProxyInference(invalid, candidates)).toBe(
      false,
    );
  });

  it("limits chapter voices to prose and excludes display titles and SFX", () => {
    expect(
      isCrossScriptProxyEligibleBlock(makeInferenceBlock("dialogue")),
    ).toBe(true);
    expect(
      isCrossScriptProxyEligibleBlock(makeInferenceBlock("sign_ui_title")),
    ).toBe(false);
    expect(
      isCrossScriptProxyEligibleBlock(
        makeInferenceBlock("sfx_impact", "sound"),
      ),
    ).toBe(false);
  });

  it("keeps the visual family but selects its face from learned stroke mass", () => {
    const rows = [
      {
        candidate: { displayId: "nanum-myeongjo/w400", fontWeight: 400 },
        inkMass: 0.12,
        score: 0.21,
      },
      {
        candidate: { displayId: "nanum-myeongjo/w800", fontWeight: 800 },
        inkMass: 0.24,
        score: 0.1,
      },
    ];

    expect(
      selectCrossScriptProxyWeightFace(rows, 0.13).candidate.fontWeight,
    ).toBe(400);
    expect(
      selectCrossScriptProxyWeightFace(rows, 0.23).candidate.fontWeight,
    ).toBe(800);
  });

  it("does not override a manual lock or the user's outline thickness", () => {
    const candidates = makeCandidates();
    const inference = makeInference(candidates);
    const locked = applyAutomaticPixelStyle({
      candidates,
      pixelInference: inference,
      result: makeDecisionResult("block_user_lock"),
      workState: undefined,
    });
    expect(locked.selectedStyle).toEqual({ fontId: "nanum-myeongjo" });

    const decision: AutomaticFontDecisionV2 = {
      result: applyAutomaticPixelStyle({
        candidates,
        pixelInference: inference,
        result: makeDecisionResult("v2_automatic"),
        workState: undefined,
      }),
      role: { primary: "dialogue", confidence: 1, alternatives: [] },
    };
    const applied = applyAutomaticFontDecisionV2(makeBlock(), decision);
    expect(applied).toMatchObject({
      fontFamily: "nanum-myeongjo",
      bold: true,
      italic: true,
      outlineWidthPx: 3.25,
      outlineWidthScale: 1.6,
    });
  });
});

function makeCandidates(): AutomaticFontCandidate[] {
  return [
    makeAutomaticFontCandidate({ fontId: "nanum-gothic", weight: 400 }),
    makeAutomaticFontCandidate({ fontId: "nanum-myeongjo", weight: 700 }),
  ];
}

function makeInference(
  candidates: readonly AutomaticFontCandidate[],
): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    kind: "verified_pixel_inference",
    pageId: "page-1",
    blockId: "B001",
    modelVersion: "font-matching-runtime-v1-test",
    candidateOrderSha256: "a".repeat(64),
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: { primary: "dialogue", confidence: 1, alternatives: [] },
    sourceStyle: {
      serifness: 0.5,
      weight: 0.5,
      width: 0.5,
      roundness: 0.5,
      strokeContrast: 0.5,
      handwritten: 0,
      angularity: 0,
      irregularity: 0,
      slant: 0,
      energy: 0,
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
      selectionScore: null,
      globalRiskLowerConfidenceBound: 0,
    },
    localEvidence: {
      rankedCandidates: candidates.map((candidate, index) =>
        makeRanked(candidate.fontId, index),
      ),
      calibratedConfidence: 0,
      noneAcceptable: true,
      catalogVersion: "test-catalog",
      modelVersion: "font-matching-runtime-v1-test",
      rendererHash: "b".repeat(64),
    },
    crossScriptProxy: {
      kind: "verified_cross_script_proxy",
      contractVersion: "font-matching-cross-script-proxy-inference-v2",
      modelVersion: "manga-font-crossscript-proxy-runtime-v2",
      voice: 1,
      voiceCount: 1,
      candidates: [
        {
          fontId: candidates[1]?.fontId ?? "",
          displayId: "nanum-myeongjo:700:normal",
          score: 0.1,
          fontWeight: 700,
          italic: true,
        },
        {
          fontId: candidates[0]?.fontId ?? "",
          displayId: "nanum-gothic:400:normal",
          score: 0.2,
          fontWeight: 400,
          italic: false,
        },
      ],
    },
  };
}

function makeRuntimeBoundInference(
  candidates: readonly AutomaticFontCandidate[],
  catalogVersion: string,
): VerifiedAutomaticFontPixelInferenceV2 {
  const inference = makeInference(candidates);
  return {
    ...inference,
    modelVersion: "runtime-model-v1",
    candidateOrderSha256: "candidate-order-v1",
    selectionCalibration: {
      applied: false,
      fallbackReason: "score_below_operating_point",
      operatingFamily: null,
      selectionScore: null,
      globalRiskLowerConfidenceBound: 0,
    },
    localEvidence: {
      ...inference.localEvidence,
      catalogVersion,
      modelVersion: "runtime-model-v1",
      rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    },
    crossScriptProxy: inference.crossScriptProxy
      ? { ...inference.crossScriptProxy, voice: 1, voiceCount: 2 }
      : undefined,
  };
}

function makeRuntimeStatus(
  candidates: readonly AutomaticFontCandidate[],
  catalogVersion: string,
): FontMatchingRuntimeArtifactStatus {
  return {
    state: "ready",
    automaticMutationAllowed: true,
    semanticBootstrapAllowed: false,
    modelVersion: "runtime-model-v1",
    catalogVersion,
    candidateIds: candidates.map((candidate) => candidate.fontId),
    candidateOrderSha256: "candidate-order-v1",
    calibration: { temperature: 1, noneThreshold: 0.5 },
    policy: {
      automaticMutation: {
        minimumAutomaticConfidence: 0.86,
        minimumRoleConfidence: 0.82,
        minimumIntentionalOverrideConfidence: 0.86,
        intentionalOverrideMinimumScoreMargin: 0.1,
      },
      chapterPrior: {
        maximumScoreContribution: 0.06,
        minimumAnchorEvidenceCount: 2,
        localOverrideMinimumScoreMargin: 0.1,
      },
    },
  };
}

function makeRanked(fontId: string, index: number): RankedFontCandidateV2 {
  return {
    rank: index + 1,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 0,
    roleFit: 0,
    layoutFit: 0,
    glyphCoverage: 1,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore: 0,
    confidence: 0,
    reasonCodes: [],
  };
}

function makeDecisionResult(
  resolvedBy: "v2_automatic" | "block_user_lock",
): FontMatchingDecisionResultV2 {
  return {
    decision: {
      mode: "apply",
      selectedFontId: "nanum-myeongjo",
      topCandidateFontIds: ["nanum-myeongjo", "nanum-gothic"],
      noneAcceptable: false,
      abstainReason: null,
      resolvedBy,
    },
    selectedStyle: { fontId: "nanum-myeongjo" },
    audit: {
      policyVersion: "font-matching-decision-v2.0",
      legacyTitleOrRegexFallbackUsed: false,
      modelReportedNoneAcceptable: false,
      localCalibratedConfidence: 1,
      roleConfidence: 1,
      genreContributionCap: 0,
      evaluatedCandidates: [],
      rejectedCandidates: [],
      priorityTrace: [],
    },
  };
}

function makeInferenceBlock(
  fontRole: OverlayItem["fontRole"],
  textRole: OverlayItem["textRole"] = "ordinary",
): FontMatchingPageInferenceBlock {
  return { blockId: "B001", item: makeItem(fontRole, textRole) };
}

function makeItem(
  fontRole: OverlayItem["fontRole"],
  textRole: OverlayItem["textRole"] = "ordinary",
): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole,
    fontRole,
    fontRoleConfidence: 1,
    direction: "horizontal",
    candidateIds: [1],
    bbox: { x: 10, y: 20, w: 70, h: 20 },
    jp: "台詞",
    ko: "대사",
    confidence: 1,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "B001",
    type: "nonsolid",
    bbox: { x: 10, y: 20, w: 70, h: 20 },
    sourceText: "台詞",
    translatedText: "대사",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontFamily: "nanum-gothic",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    outlineWidthPx: 3.25,
    outlineWidthScale: 1.6,
    bold: false,
    italic: false,
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
