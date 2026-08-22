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
import type { FontMatchingOcrGeometryDirectionV2 } from "./fontMatchingOcrGeometryDirection";
import type {
  FontMatchingOcrCandidateMembershipV2,
  OverlayItem,
} from "./types";

export type FontMatchingInferenceInputBoundary = Readonly<{
  source: "user_page";
  datasetSplit: null;
  qaOverlay: false;
}>;

export const USER_PAGE_FONT_MATCHING_BOUNDARY: FontMatchingInferenceInputBoundary =
  Object.freeze({ source: "user_page", datasetSplit: null, qaOverlay: false });

export type FontMatchingPageRelativeBaselineConsistencyState = Readonly<{
  mode: "stable_body" | "page_anchor" | "local_visual_variant";
  anchorFontId?: string;
  anchorEvidenceCount: number;
  anchorSupportShare?: number;
  printedFamily?: "sans" | "serif";
  recoveredBody?: boolean;
  geometryComponentForced?: boolean;
  ordinaryMorphologyConsensus?: boolean;
  stableMeanConsensus?: boolean;
  emphasisMorphologyConsensus?: boolean;
  dohyeonMorphologyVeto?: boolean;
  dohyeonDominanceClusterRescue?: boolean;
  dohyeonMorphologyRecoveryFontId?: string;
  dohyeonMorphologyRecoveryRoute?:
    | "inverse_page_anchor"
    | "strong_page_anchor"
    | "residual_stable_body"
    | "non_dohyeon_top3"
    | "non_dohyeon_variant_top3";
}>;

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
  /** Explicit QA-only pre-calibration page-relative route audit. */
  pageRelativeRoleQa?: Readonly<{
    policyVersion: "font-matching-page-relative-role-qa-v2";
    status:
      | "applied"
      | "unchanged"
      | "dual_branch_unavailable"
      | "reverted_apply_rate_guard";
    originalRole: FontMatchingSemanticRole;
    projectedRole: FontMatchingSemanticRole;
    routeFamily: "body" | "variant";
    /** Code-owned OCR bbox direction; absent evidence is represented as null. */
    sourceGeometryDirection: FontMatchingOcrGeometryDirectionV2 | null;
    clusterId: string | null;
    /** Stable body anchor derived from the sealed dual-head scores for this morphology cluster. */
    clusterBodyAnchorFontId: string | null;
    /** Exact pre-reroute page state; unchanged rows restore this downstream. */
    baselinePageConsistencyState: FontMatchingPageRelativeBaselineConsistencyState | null;
    preferredPeerFontId: string | null;
    peerBlockId: string | null;
    reasonCodes: readonly string[];
    confidencePolicy: "preserve_original_pixel_primary_confidence";
    applyRateGuard: "selection_calibration_non_decreasing";
  }>;
  selectionCalibration: FontMatchingSelectionCalibrationAudit;
  /** Versioned pixel-only glyph geometry used by page-policy audit/vetoes. */
  glyphMorphology?: FontMatchingGlyphMorphologyV1;
  /** Page-local visual voice selected by the user-approved cross-script model. */
  crossScriptProxy?: VerifiedCrossScriptProxyInferenceV1;
  localEvidence: BlockLocalFontEvidenceV2;
}>;

export type FontMatchingPageInferenceBlock = Readonly<{
  blockId: string;
  item: OverlayItem;
  /** Trusted sibling commitment produced before the worker transport. */
  sourceCandidateMembership?: FontMatchingOcrCandidateMembershipV2;
  /** Derived before inference from immutable OCR candidate rectangles only. */
  sourceGeometryDirection?: FontMatchingOcrGeometryDirectionV2;
  /** Geometry/count-only glyph cells for the meaning-free cross-script model. */
  sourceGlyphInput?: FontMatchingSourceGlyphInputV1;
}>;

export type FontMatchingSourceGlyphLineV1 = Readonly<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  glyphCount: number;
}>;

export type FontMatchingSourceGlyphInputV1 = Readonly<{
  contractVersion: "font-matching-source-glyph-input-v1";
  source: "semantic_ocr_geometry_and_count_only";
  direction: "horizontal" | "vertical";
  lines: readonly FontMatchingSourceGlyphLineV1[];
  fallbackGlyphCount: number;
}>;

export type CrossScriptProxyCandidateV1 = Readonly<{
  fontId: string;
  displayId: string;
  score: number;
  fontWeight: number;
  italic: boolean;
}>;

export type VerifiedCrossScriptProxyInferenceV1 = Readonly<{
  kind: "verified_cross_script_proxy";
  contractVersion: "font-matching-cross-script-proxy-inference-v2";
  modelVersion: "manga-font-crossscript-proxy-runtime-v2";
  voice: number;
  voiceCount: number;
  candidates: readonly CrossScriptProxyCandidateV1[];
}>;

export type FontMatchingPageInferenceRequest = Readonly<{
  page: MangaPage;
  blocks: readonly FontMatchingPageInferenceBlock[];
  candidates: readonly AutomaticFontCandidate[];
  targetLanguage?: string;
  boundary: FontMatchingInferenceInputBoundary;
  /**
   * QA runner opt-in only. Default/omitted is false.
   * TODO(font-matching-qa-capability): move this off the general request and
   * gate it with a capability injected when the dedicated QA port is created.
   */
  qaPageRelativeRoleReroute?: boolean;
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
  /** Release worker/session resources when the owning pipeline run finishes. */
  dispose?: () => Promise<void>;
}>;
