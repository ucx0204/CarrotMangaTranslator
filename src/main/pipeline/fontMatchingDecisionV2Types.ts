import type {
  FontMatchDecisionV2,
  FontMatchRolePredictionV2,
  FontMatchingDecisionPrioritySource,
  FontMatchingTreatmentV2,
  FontStyleSelectionV2,
  RankedFontCandidateV2,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";

export type BlockLocalFontEvidenceV2 = Readonly<{
  rankedCandidates: readonly RankedFontCandidateV2[];
  calibratedConfidence: number;
  noneAcceptable: boolean;
  catalogVersion: string;
  modelVersion: string;
  rendererHash: string;
}>;

export type TranslationFontAssessmentV2 = Readonly<{
  fontId: string;
  glyphCoverage: number;
  glyphsRenderable: boolean;
  missingGlyphCount: number;
  layoutScore: number;
  layoutFeasible: boolean;
}>;

export type FontMatchingDecisionCalibrationV2 = Readonly<{
  minimumAutomaticConfidence: number;
  minimumRoleConfidence: number;
  minimumIntentionalOverrideConfidence: number;
  intentionalOverrideMinimumScoreMargin: number;
}>;

export type FontMatchingWorkStateV2 = Readonly<{
  visualClusterId?: string | null;
  visualClusterFontId?: string | null;
  rolePaletteUsedFontIds?: readonly string[];
}>;

export type FontMatchingDecisionInputV2 = Readonly<{
  workId: string;
  chapterId: string;
  pageId: string;
  blockId: string;
  role: FontMatchRolePredictionV2;
  treatment: Pick<FontMatchingTreatmentV2, "orientation">;
  localEvidence: BlockLocalFontEvidenceV2;
  translationAssessments: readonly TranslationFontAssessmentV2[];
  profile: WorkTypographyProfileV2 | null;
  /** `undefined` loads the persisted profile lock; `null` suppresses it. */
  blockUserLock?: FontStyleSelectionV2 | null;
  /** `undefined` loads the persisted profile lock; `null` suppresses it. */
  workRoleUserLock?: FontStyleSelectionV2 | null;
  userDefaultCandidate: FontStyleSelectionV2 | null;
  workState?: FontMatchingWorkStateV2;
  calibration: FontMatchingDecisionCalibrationV2;
}>;

export type FontCandidateHardRejectReasonV2 =
  | "render_unavailable"
  | "translation_assessment_missing"
  | "glyph_render_failure"
  | "glyph_coverage_incomplete"
  | "layout_infeasible"
  | "horizontal_orientation_forbidden"
  | "vertical_orientation_forbidden";

export type FontCandidatePolicyRejectReasonV2 =
  | "lock_target_unavailable"
  | "outside_anchor_set"
  | "outside_role_palette"
  | "palette_distinct_limit_reached"
  | "intentional_override_low_confidence"
  | "intentional_override_score_missing"
  | "intentional_override_margin_not_met"
  | "profile_target_unavailable"
  | "automatic_confidence_below_threshold"
  | "model_reported_none_acceptable"
  | "user_default_unavailable";

export type FontCandidateRejectReasonV2 =
  | FontCandidateHardRejectReasonV2
  | FontCandidatePolicyRejectReasonV2;

export type FontCandidateDecisionAuditV2 = Readonly<{
  fontId: string;
  originalRank: number | null;
  originalTotalScore: number | null;
  effectiveScore: number | null;
  calibratedCandidateConfidence: number | null;
  translationGlyphCoverage: number | null;
  translationLayoutScore: number | null;
  appliedGenreContribution: number;
  genreContributionClamped: boolean;
  hardRejectReasons: readonly FontCandidateHardRejectReasonV2[];
}>;

export type FontCandidateRejectionAuditV2 = Readonly<{
  fontId: string;
  kind: "hard" | "policy";
  reasonCodes: readonly FontCandidateRejectReasonV2[];
}>;

export type FontDecisionPriorityTraceV2 = Readonly<{
  priority: FontMatchingDecisionPrioritySource;
  status: "selected" | "skipped" | "rejected" | "abstained" | "not_reached";
  candidateFontId: string | null;
  reasonCodes: readonly string[];
}>;

export type FontMatchingDecisionResultV2 = Readonly<{
  decision: FontMatchDecisionV2;
  selectedStyle: FontStyleSelectionV2 | null;
  audit: Readonly<{
    policyVersion: "font-matching-decision-v2.0";
    legacyTitleOrRegexFallbackUsed: false;
    modelReportedNoneAcceptable: boolean;
    localCalibratedConfidence: number;
    roleConfidence: number;
    genreContributionCap: number;
    evaluatedCandidates: readonly FontCandidateDecisionAuditV2[];
    rejectedCandidates: readonly FontCandidateRejectionAuditV2[];
    priorityTrace: readonly FontDecisionPriorityTraceV2[];
  }>;
}>;
