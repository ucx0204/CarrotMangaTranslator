import { describe, expect, it } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
} from "../src/main/pipeline/automaticFontMatchingV2";
import { overlayItemToBlock } from "../src/main/pipeline/overlayItems";
import { buildTranslatedPageResult } from "../src/main/pipeline/translatedPageResult";
import type { AutomaticFontPageCoordinatorV2 } from "../src/main/pipeline/automaticFontMatchingV2PageCoordinator";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimeArtifactStatus } from "../src/main/pipeline/fontMatchingRuntimeArtifactStatus";
import type { OverlayItem } from "../src/main/pipeline/types";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";
import type { WorkTypographyProfileV2 } from "../src/shared/fontMatchingProfileTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

const { normalizeItems } =
  require("../src/main/runtime/overlay-parser.cjs") as {
    normalizeItems: (parsed: unknown) => OverlayItem[];
  };

describe("translated page Font Matching V2 coordination", () => {
  it("does not reuse profile fonts without verified pixel inference", () => {
    const page = makePage();
    const candidates = makeCandidates();
    const profile = makeProfile(candidates);
    const items = [
      makeSfxItem(1, "ドン!", "힣"),
      makeSfxItem(2, " ドン ", "가"),
    ];
    const automaticFont = {
      enabled: true,
      targetLanguage: "ko",
      workId: "work-1",
      chapterId: "chapter-1",
      profile,
      candidates,
    } as const;

    const independentSecond = overlayItemToBlock(
      items[1],
      page,
      1,
      "run-1",
      undefined,
      undefined,
      automaticFont,
    );
    expect(independentSecond.fontFamily).toBeUndefined();

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingWorkId: "work-1",
        fontMatchingChapterId: "chapter-1",
        fontMatchingProfile: profile,
        fontMatchingCandidates: candidates,
      }),
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.page.blocks).toHaveLength(2);
    expect(result.page.blocks.map((block) => block.id)).toEqual([
      "page-1-run-1-block-1",
      "page-1-run-1-block-2",
    ]);
    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("keeps the page when block-local font matching evidence is invalid", () => {
    const duplicate = builtIn("dohyeon", [[0, 0x10ffff]]);
    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page: makePage(),
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingCandidates: [duplicate, { ...duplicate }],
      }),
      items: [makeSfxItem(1, "ドン", "쾅")],
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.kind).toBe("completed");
    expect(result.page.blocks).toHaveLength(1);
    expect(result.page.blocks[0].fontFamily).toBeUndefined();
  });

  it("does not enforce profile palette state without verified pixel inference", () => {
    const page = makePage();
    const candidates = [
      builtIn("dohyeon", [[0xac00, 0xac00]]),
      builtIn("start-over", [[0xac00, 0xac01]]),
      builtIn("jua", [[0xac00, 0xd7a3]], { defaultFont: true }),
    ];
    const profile = makeProfile(candidates, 2);
    const items = [
      makeSfxItem(1, "ドン", "힣"),
      makeSfxItem(2, "シュッ", "각"),
      makeSfxItem(3, "バン", "가"),
    ];

    const independentThird = overlayItemToBlock(
      items[2],
      page,
      2,
      "run-1",
      undefined,
      undefined,
      {
        enabled: true,
        targetLanguage: "ko",
        workId: "work-1",
        chapterId: "chapter-1",
        profile,
        candidates,
      },
    );
    expect(independentThird.fontFamily).toBeUndefined();

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingWorkId: "work-1",
        fontMatchingChapterId: "chapter-1",
        fontMatchingProfile: profile,
        fontMatchingCandidates: candidates,
      }),
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("preserves a pixel display winner while coordinating neutral-head body text", () => {
    const page = makePage();
    const candidates = [
      builtIn("nanum-barun-gothic", [[0xac00, 0xd7a3]]),
      builtIn("dohyeon", [[0xac00, 0xd7a3]]),
    ];
    const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
    const status = makeReadyRuntimeStatus(candidates, catalogVersion);
    const variantBlockId = `${page.id}-run-1-block-1`;
    const bodyBlockId = `${page.id}-run-1-block-2`;
    const variant = makeNeutralPixelInference({
      blockId: variantBlockId,
      candidates,
      catalogVersion,
      pageId: page.id,
      winnerFontId: "dohyeon",
    });
    const body = makeNeutralPixelInference({
      blockId: bodyBlockId,
      candidates,
      catalogVersion,
      pageId: page.id,
      winnerFontId: "nanum-barun-gothic",
    });
    const preparationOrder: string[] = [];
    const recordedBlockIds: string[] = [];
    const chapterCoordinator = {
      prepareWorkState(_item, _role, inference) {
        if (inference) preparationOrder.push(inference.blockId);
        return undefined;
      },
      recordDecision(_role, _workState, _result, _profile, inference) {
        if (inference) recordedBlockIds.push(inference.blockId);
      },
    } satisfies AutomaticFontPageCoordinatorV2;

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page,
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingCandidates: candidates,
      }),
      items: [
        makeSfxItem(1, "ドン", "쾅"),
        makeSfxItem(2, "ありがとう", "고마워"),
      ],
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
      fontMatchingPageInference: {
        runtimeArtifactStatus: status,
        pixelInferenceByBlockId: new Map([
          [variantBlockId, variant],
          [bodyBlockId, body],
        ]),
      },
      fontMatchingChapterCoordinator: chapterCoordinator,
    });

    expect(preparationOrder).toEqual([bodyBlockId, variantBlockId]);
    expect(recordedBlockIds).toEqual([bodyBlockId]);
    expect(result.page.blocks.map((block) => block.id)).toEqual([
      variantBlockId,
      bodyBlockId,
    ]);
    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      "dohyeon",
      "nanum-barun-gothic",
    ]);
  });

  it("carries a parsed explicit accent cluster into page coordination", () => {
    const candidates = makeCandidates();
    const profile = makeProfile(
      candidates,
      candidates.length,
      "aside_balloon_edge",
    );
    const items = normalizeItems({
      items: [
        {
          id: 1,
          type: "nonsolid",
          textRole: "ordinary",
          fontRole: "aside_balloon_edge",
          fontRoleConfidence: 0.98,
          visual_cluster_id: " aside-note-1 ",
          x1: 100,
          y1: 100,
          x2: 300,
          y2: 180,
          jp: "こそ",
          ko: "힣",
        },
        {
          id: 2,
          type: "nonsolid",
          textRole: "ordinary",
          fontRole: "aside_balloon_edge",
          fontRoleConfidence: 0.98,
          visualClusterId: "aside-note-1",
          x1: 100,
          y1: 220,
          x2: 300,
          y2: 300,
          jp: "こそ",
          ko: "가",
        },
      ],
    });

    const result = buildTranslatedPageResult({
      jobId: "run-1",
      page: makePage(),
      pageOptions: makeTranslationOptions({
        targetLanguage: "ko",
        autoFontMatching: true,
        fontMatchingWorkId: "work-1",
        fontMatchingChapterId: "chapter-1",
        fontMatchingProfile: profile,
        fontMatchingCandidates: candidates,
      }),
      items,
      soundDroppedCount: 0,
      validationDroppedCount: 0,
      validationReasons: {},
      contextWarnings: [],
    });

    expect(result.page.blocks.map((block) => block.fontFamily)).toEqual([
      undefined,
      undefined,
    ]);
    expect(result.page.blocks.map((block) => block.visualClusterId)).toEqual([
      "aside-note-1",
      "aside-note-1",
    ]);
  });
});

function makeCandidates(): AutomaticFontCandidate[] {
  return [
    builtIn("dohyeon", [[0xac00, 0xac00]]),
    builtIn("jua", [[0xac00, 0xd7a3]], { defaultFont: true }),
  ];
}

function builtIn(
  fontId: string,
  unicodeRanges: AutomaticFontCandidate["unicodeRanges"],
  overrides: Partial<AutomaticFontCandidate> = {},
): AutomaticFontCandidate {
  return makeAutomaticFontCandidate({
    source: "built-in",
    fontId,
    defaultFont: false,
    unicodeRanges,
    ...overrides,
  });
}

function makeProfile(
  candidates: readonly AutomaticFontCandidate[],
  maxDistinctFonts = candidates.length,
  role: WorkTypographyProfileV2["rolePalettes"][number]["role"] = "sfx_impact",
): WorkTypographyProfileV2 {
  const timestamp = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    workId: "work-1",
    dialogueAnchor: null,
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [
      {
        role,
        allowedFontIds: candidates.map((candidate) => candidate.fontId),
        maxDistinctFonts,
        reuseVisualClusterFont: true,
        evidenceCount: 20,
        confidence: 1,
      },
    ],
    intentionalOverrides: [],
    userLocks: [],
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: [],
    },
    consistencyPolicy: {
      reuseBodyAnchors: true,
      requireIntentionalOverrideForBodySwitch: true,
      reuseVisualClusterFont: true,
      maxAccentFontsPerRole: 4,
    },
    genrePrior: null,
    evidenceCount: 20,
    confidence: 1,
    catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
    modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
    rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeSfxItem(
  id: number,
  sourceText: string,
  translatedText: string,
): OverlayItem {
  return {
    id,
    type: "nonsolid",
    textRole: "sound",
    fontRole: "sfx_impact",
    fontRoleConfidence: 0.98,
    bbox: { x: 100, y: 100 + id * 100, w: 200, h: 80 },
    jp: sourceText,
    ko: translatedText,
    sourceText,
    translatedText,
    direction: "horizontal",
    confidence: 1,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeTranslationOptions(
  overrides: Partial<TranslationOptions>,
): TranslationOptions {
  return overrides as TranslationOptions;
}

function makeReadyRuntimeStatus(
  candidates: readonly AutomaticFontCandidate[],
  catalogVersion: string,
): FontMatchingRuntimeArtifactStatus {
  return {
    state: "ready",
    automaticMutationAllowed: true,
    semanticBootstrapAllowed: false,
    modelVersion: "neutral-head-runtime-v1",
    catalogVersion,
    candidateIds: candidates.map(({ fontId }) => fontId),
    candidateOrderSha256: "neutral-head-order-v1",
    calibration: { temperature: 1, noneThreshold: 0.5 },
    policy: {
      automaticMutation: {
        minimumAutomaticConfidence: 0.82,
        minimumRoleConfidence: 0.75,
        minimumIntentionalOverrideConfidence: 0.88,
        intentionalOverrideMinimumScoreMargin: 0.12,
      },
      chapterPrior: {
        maximumScoreContribution: 0.08,
        minimumAnchorEvidenceCount: 3,
        localOverrideMinimumScoreMargin: 0.12,
      },
    },
  };
}

function makeNeutralPixelInference({
  blockId,
  candidates,
  catalogVersion,
  pageId,
  winnerFontId,
}: {
  blockId: string;
  candidates: readonly AutomaticFontCandidate[];
  catalogVersion: string;
  pageId: string;
  winnerFontId: string;
}): VerifiedAutomaticFontPixelInferenceV2 {
  const ordered = [
    winnerFontId,
    ...candidates
      .map(({ fontId }) => fontId)
      .filter((fontId) => fontId !== winnerFontId),
  ];
  return {
    kind: "verified_pixel_inference",
    pageId,
    blockId,
    modelVersion: "neutral-head-runtime-v1",
    candidateOrderSha256: "neutral-head-order-v1",
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: {
      primary: "dialogue",
      confidence: 1 / 14,
      alternatives: [],
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
      orientation: "horizontal",
      outline: "none",
      shadow: "none",
      fill: "solid",
      distortion: "none",
      polarity: "unknown",
      colorMode: "unknown",
    },
    selectionCalibration: {
      applied: true,
      fallbackReason: null,
      operatingFamily: winnerFontId === "dohyeon" ? "variant" : "body",
      selectionScore: 0.96,
      globalRiskLowerConfidenceBound: 0.9,
    },
    glyphMorphology: {
      contractVersion: "font-matching-glyph-morphology-v1",
      maskSource: "raw_grayscale_otsu_minority_area3",
      distanceTransform: "opencv_dist_l2_mask5",
      connectivity: 8,
      maskWidth: 80,
      maskHeight: 40,
      otsuThreshold: 100,
      foregroundPolarity: "dark",
      foregroundPixelCount: 240,
      connectedComponentCount: 3,
      globalForegroundDistanceMean: 1.8,
      medianComponentDistanceMean: 1.8,
      medianComponentFill: 0.62,
      foregroundMeanLuma: 30,
      backgroundMeanLuma: 230,
    },
    localEvidence: {
      rankedCandidates: ordered.map((fontId, index) => ({
        rank: index + 1,
        fontId,
        renderStatus: "rendered",
        unrenderableReason: null,
        styleFit: index === 0 ? 0.96 : 0.32,
        roleFit: 1 / 14,
        layoutFit: 0,
        glyphCoverage: 1,
        workProfileFit: 0,
        userPreferenceFit: 0,
        genrePriorContribution: 0,
        switchPenalty: 0,
        totalScore: index === 0 ? 0.96 : 0.32,
        confidence: index === 0 ? 0.9 : 0,
        rawPixelRank: index + 1,
        rawPixelScore: index === 0 ? 0.96 : 0.32,
        reasonCodes: ["pixel_model"],
      })),
      calibratedConfidence: 0.9,
      noneAcceptable: false,
      catalogVersion,
      modelVersion: "neutral-head-runtime-v1",
      rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    },
  };
}
