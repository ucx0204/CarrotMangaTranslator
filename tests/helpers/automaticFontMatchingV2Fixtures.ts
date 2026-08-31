import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
} from "../../src/main/pipeline/automaticFontMatchingV2";
import type { FontMatchingDecisionResultV2 } from "../../src/main/pipeline/fontMatchingDecisionV2";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "../../src/main/pipeline/fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimeArtifactStatus } from "../../src/main/pipeline/fontMatchingRuntimeArtifactStatus";
import type { OverlayItem } from "../../src/main/pipeline/types";
import type {
  FontMatchingSourceStyleV2,
  RankedFontCandidateV2,
  WorkTypographyProfileV2,
} from "../../src/shared/fontMatchingProfileTypes";
import type { MangaPage } from "../../src/shared/libraryTypes";
import type { TranslationBlock } from "../../src/shared/textTypes";
import { makeAutomaticFontCandidate } from "./automaticFontCandidate";

export function makeCoordinatorResult(
  fontId: string,
  reasonCodes: string[] = ["role_palette"],
  resolvedBy:
    | "work_profile"
    | "work_role_user_lock"
    | "v2_automatic" = "work_profile",
): FontMatchingDecisionResultV2 {
  return {
    decision: {
      mode: "apply",
      selectedFontId: fontId,
      topCandidateFontIds: [fontId],
      noneAcceptable: false,
      abstainReason: null,
      resolvedBy,
    },
    selectedStyle: { fontId },
    audit: {
      policyVersion: "font-matching-decision-v2.0",
      legacyTitleOrRegexFallbackUsed: false,
      modelReportedNoneAcceptable: false,
      localCalibratedConfidence: 0,
      roleConfidence: 1,
      genreContributionCap: 0,
      evaluatedCandidates: [],
      rejectedCandidates: [],
      priorityTrace: [
        {
          priority: "work_profile",
          status: "selected",
          candidateFontId: fontId,
          reasonCodes,
        },
      ],
    },
  };
}

export function makeReadyRuntimeStatus(
  candidates: ReturnType<typeof builtIn>[],
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

export function makePixelInference({
  blockId,
  catalogVersion,
  pageId,
  scores,
  selectionCalibration,
  sourceStyle,
}: {
  blockId: string;
  catalogVersion: string;
  pageId: string;
  scores: [number, number];
  selectionCalibration?: VerifiedAutomaticFontPixelInferenceV2["selectionCalibration"];
  sourceStyle: FontMatchingSourceStyleV2;
}): VerifiedAutomaticFontPixelInferenceV2 {
  const fontIds = ["jua", "dohyeon"];
  const rankedCandidates = fontIds
    .map((fontId, index) =>
      makeRankedCandidate(fontId, scores[index] ?? 0, index + 1),
    )
    .sort((left, right) => right.totalScore - left.totalScore)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      rawPixelRank: index + 1,
      confidence: index === 0 ? 0.97 : 0,
    }));
  return {
    kind: "verified_pixel_inference",
    pageId,
    blockId,
    modelVersion: "runtime-model-v1",
    candidateOrderSha256: "candidate-order-v1",
    inputBoundary: {
      source: "user_page",
      datasetSplit: null,
      qaOverlay: false,
    },
    rolePrediction: {
      primary: "dialogue",
      confidence: 0.99,
      alternatives: [],
    },
    sourceStyle,
    treatment: {
      orientation: "horizontal",
      outline: "none",
      shadow: "none",
      fill: "solid",
      distortion: "none",
      polarity: "normal",
      colorMode: "monochrome",
    },
    selectionCalibration: selectionCalibration ?? {
      applied: true,
      fallbackReason: null,
      operatingFamily: "body",
      selectionScore: 0.97,
      globalRiskLowerConfidenceBound: 0.9,
    },
    localEvidence: {
      rankedCandidates,
      calibratedConfidence: 0.97,
      noneAcceptable: false,
      catalogVersion,
      modelVersion: "runtime-model-v1",
      rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    },
  };
}

export function makePixelWinnerInference(
  winnerFontId: string,
  blockId: string,
): VerifiedAutomaticFontPixelInferenceV2 {
  const inference = makePixelInference({
    blockId,
    catalogVersion: "pixel-only-order-catalog",
    pageId: "pixel-only-order-page",
    scores: [0.94, 0.72],
    sourceStyle: makeSourceStyle({
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
    }),
  });
  return {
    ...inference,
    rolePrediction: {
      primary: "dialogue",
      confidence: 1 / 14,
      alternatives: [],
    },
    localEvidence: {
      ...inference.localEvidence,
      rankedCandidates: inference.localEvidence.rankedCandidates.map(
        (candidate, index) => ({
          ...candidate,
          fontId:
            index === 0
              ? winnerFontId
              : winnerFontId === "dohyeon" ||
                  winnerFontId === "griun-pol-sensibility"
                ? "jua"
                : "dohyeon",
          rawPixelScore: candidate.totalScore,
        }),
      ),
    },
  };
}

export function makePixelRoleInference(
  primary: VerifiedAutomaticFontPixelInferenceV2["rolePrediction"]["primary"],
  blockId: string,
): VerifiedAutomaticFontPixelInferenceV2 {
  return {
    ...makePixelWinnerInference("dohyeon", blockId),
    rolePrediction: { primary, confidence: 1, alternatives: [] },
  };
}

export function makeRankedCandidate(
  fontId: string,
  score: number,
  rank: number,
): RankedFontCandidateV2 {
  return {
    rank,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: score,
    roleFit: score,
    layoutFit: 0,
    glyphCoverage: 1,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore: score,
    confidence: 0,
    reasonCodes: ["pixel_model"],
  };
}

export function makeSourceStyle(
  overrides: Partial<FontMatchingSourceStyleV2> = {},
): FontMatchingSourceStyleV2 {
  return {
    serifness: 0.12,
    weight: 0.48,
    width: 0.5,
    roundness: 0.42,
    strokeContrast: 0.35,
    handwritten: 0.08,
    angularity: 0.22,
    irregularity: 0.12,
    slant: 0.08,
    energy: 0.2,
    unknownFields: [],
    ...overrides,
  };
}

export function builtIn(fontId: string) {
  return makeAutomaticFontCandidate({
    source: "built-in",
    fontId,
    defaultFont: fontId === "jua",
  });
}

export function makeItem(
  fontRole: OverlayItem["fontRole"],
  fontRoleConfidence: number,
): OverlayItem {
  return {
    id: 1,
    type: "nonsolid",
    textRole: fontRole?.startsWith("sfx_") ? "sound" : "ordinary",
    fontRole,
    fontRoleConfidence,
    bbox: { x: 100, y: 100, w: 200, h: 120 },
    jp: "ドン",
    ko: "쾅!",
    confidence: 1,
  };
}

export function makeBlock(
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 120 },
    bboxSpace: "normalized_1000",
    sourceText: "ドン",
    translatedText: "쾅!",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    rotationDeg: 0,
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: true,
    ...overrides,
  };
}

export function makePage(): MangaPage {
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

export function makeProfile(
  overrides: Partial<WorkTypographyProfileV2> = {},
): WorkTypographyProfileV2 {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    schemaVersion: 2,
    workId: "work-1",
    dialogueAnchor: {
      primaryFontId: "ridi-batang",
      allowedFontIds: ["ridi-batang"],
      origin: "manual",
      evidenceCount: 20,
      confidence: 1,
      replacementPolicy: {
        minimumEvidenceCount: 20,
        minimumScoreMargin: 0.1,
      },
      updatedAt: now,
    },
    narrationAnchor: null,
    thoughtAnchor: null,
    rolePalettes: [],
    intentionalOverrides: [],
    userLocks: [],
    orientationPolicy: {
      horizontalAllowedFontIds: null,
      verticalAllowedFontIds: null,
      verticalOnlyFontIds: ["seoul-namsan-vertical"],
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
    catalogVersion: "test-profile-without-runtime-manifest",
    modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
    rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
