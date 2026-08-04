import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSemanticRole,
  FontMatchingSourceStyleV2,
  FontMatchingTreatmentV2,
  FontMatchRolePredictionV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { BlockLocalFontEvidenceV2 } from "./fontMatchingDecisionV2Types";
import type { FontMatchingGlyphMorphologyV1 } from "./fontMatchingPagePixelPreprocessing";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import type { OverlayItem } from "./types";

export type FontMatchingInferenceInputBoundary = Readonly<{
  source: "user_page";
  datasetSplit: null;
  qaOverlay: false;
}>;

export const USER_PAGE_FONT_MATCHING_BOUNDARY: FontMatchingInferenceInputBoundary =
  Object.freeze({ source: "user_page", datasetSplit: null, qaOverlay: false });

type FontMatchingSelectionCalibrationAudit = Readonly<{
  applied: boolean;
  fallbackReason:
    | "none_acceptable"
    | "severe_input_invalid"
    | "feature_boundary_invalid"
    | "invalid_calibrated_score"
    | "score_below_operating_point"
    | "no_renderable_top3"
    | null;
  operatingFamily: "body" | "variant" | "global" | null;
  selectionScore: number | null;
  globalRiskLowerConfidenceBound: number;
}>;

export type VerifiedAutomaticFontPixelInferenceV2 = Readonly<{
  kind: "verified_pixel_inference";
  pageId: string;
  blockId: string;
  modelVersion: string;
  candidateOrderSha256: string;
  inputBoundary: FontMatchingInferenceInputBoundary;
  rolePrediction: FontMatchRolePredictionV2;
  sourceStyle: FontMatchingSourceStyleV2;
  treatment: FontMatchingTreatmentV2;
  scoreRoute?: Readonly<{
    family: "body" | "variant";
    outputName: "body_candidate_scores" | "variant_candidate_scores";
    resolvedRole: FontMatchingSemanticRole;
  }>;
  selectionCalibration: FontMatchingSelectionCalibrationAudit;
  /** Versioned pixel-only glyph geometry used by page-policy audit/vetoes. */
  glyphMorphology?: FontMatchingGlyphMorphologyV1;
  localEvidence: BlockLocalFontEvidenceV2;
}>;

export type FontMatchingPageInferenceBlock = Readonly<{
  blockId: string;
  item: OverlayItem;
}>;

export type FontMatchingPageInferenceRequest = Readonly<{
  page: MangaPage;
  blocks: readonly FontMatchingPageInferenceBlock[];
  candidates: readonly AutomaticFontCandidate[];
  targetLanguage?: string;
  boundary: FontMatchingInferenceInputBoundary;
  signal?: AbortSignal;
}>;

export type FontMatchingPageInferenceResult = Readonly<{
  runtimeArtifactStatus?: FontMatchingRuntimeArtifactStatus;
  pixelInferenceByBlockId: ReadonlyMap<
    string,
    VerifiedAutomaticFontPixelInferenceV2
  >;
}>;

export type FontMatchingPageInferencePort = Readonly<{
  inferPage: (
    request: FontMatchingPageInferenceRequest,
  ) => Promise<FontMatchingPageInferenceResult>;
}>;
