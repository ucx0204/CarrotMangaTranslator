/* eslint-disable max-lines, max-lines-per-function -- supervised reorder and rank-preserving audit codes form one atomic policy */
import type {
  FontMatchingSemanticRole,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type {
  FontMatchingSelectionCalibration,
  FontMatchingSelectionCalibrationV1,
  FontMatchingSelectionCalibrationV2,
  FontMatchingSelectionOperatingPoint,
} from "./fontMatchingSelectionCalibrationContract";
import { FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2 } from "./fontMatchingSelectionCalibrationContract";
import type { FontMatchingSelectionFeatureSet } from "./fontMatchingSelectionCalibrationFeatures";

const BODY_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

const VARIANT_ROLES = new Set<FontMatchingSemanticRole>([
  "whisper",
  "aside_balloon_edge",
  "emphasis_dialogue",
  "shout",
  "sfx_impact",
  "sfx_motion",
  "sfx_ambient",
  "sfx_emotion",
  "sfx_comic",
  "sign_ui_title",
]);
const MINIMUM_GLOBAL_PREFERRED_AT1 = 0.45;
const MINIMUM_VARIANT_PREFERRED_AT1 = 0.5;
type ReleaseQualityOptions = Readonly<{ allowFailedReleaseQuality?: boolean }>;

/** A diagnostic calibration may parse, but only release evidence can mutate. */
export function isFontMatchingSelectionCalibrationDeploymentReady(
  calibration: FontMatchingSelectionCalibration,
  options: ReleaseQualityOptions = {},
): boolean {
  const allowFailedReleaseQuality = Boolean(options.allowFailedReleaseQuality);
  const primaryEvidenceReady = Boolean(
    deploymentPointReady(
      calibration.operatingPoints.global,
      MINIMUM_GLOBAL_PREFERRED_AT1,
      allowFailedReleaseQuality,
    ) &&
    deploymentPointReady(
      calibration.operatingPoints.variant,
      MINIMUM_VARIANT_PREFERRED_AT1,
      allowFailedReleaseQuality,
    ),
  );
  if (
    !primaryEvidenceReady ||
    calibration.schemaVersion !== FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2
  ) {
    return primaryEvidenceReady;
  }
  const nested = calibration.oofReport.nested_operating_evaluation as Readonly<{
    global: FontMatchingSelectionOperatingPoint;
    variant: FontMatchingSelectionOperatingPoint;
  }>;
  return Boolean(
    deploymentPointReady(
      nested.global,
      MINIMUM_GLOBAL_PREFERRED_AT1,
      allowFailedReleaseQuality,
    ) &&
    deploymentPointReady(
      nested.variant,
      MINIMUM_VARIANT_PREFERRED_AT1,
      allowFailedReleaseQuality,
    ),
  );
}

function deploymentPointReady(
  point: FontMatchingSelectionOperatingPoint,
  minimumPreferredAt1: number,
  allowFailedReleaseQuality: boolean,
): boolean {
  return Boolean(
    point.enabled &&
    point.coverage_floor_passed &&
    (allowFailedReleaseQuality ||
      (point.precision_target_passed &&
        point.preferred_at1 + 1e-12 >= minimumPreferredAt1)),
  );
}

export type FontMatchingSupervisedSelectionInput = Readonly<{
  rankedCandidates: readonly RankedFontCandidateV2[];
  role: FontMatchingSemanticRole;
  calibration: FontMatchingSelectionCalibration;
  featureSet: FontMatchingSelectionFeatureSet | null;
  noneAcceptable: boolean;
  severeInputInvalid?: boolean;
  allowFailedReleaseQuality?: boolean;
}>;

export type FontMatchingSupervisedSelectionResult = Readonly<{
  rankedCandidates: readonly RankedFontCandidateV2[];
  calibrationApplied: boolean;
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
}>;

/**
 * Rerank only the original ONNX top three with supervised acceptability.
 * A validated family operating point is preferred, while the sealed global
 * coverage operating point keeps ordinary valid inputs automatically usable.
 */
export function applySupervisedFontSelectionCalibration({
  rankedCandidates,
  role,
  calibration,
  featureSet,
  noneAcceptable,
  severeInputInvalid = false,
  allowFailedReleaseQuality = false,
}: FontMatchingSupervisedSelectionInput): FontMatchingSupervisedSelectionResult {
  if (
    calibration.schemaVersion === FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2
  ) {
    return applyRankPreservingConfidenceCalibration({
      rankedCandidates,
      role,
      calibration,
      featureSet,
      noneAcceptable,
      severeInputInvalid,
      allowFailedReleaseQuality,
    });
  }
  const original = [...rankedCandidates].sort(compareOriginalCandidates);
  if (
    noneAcceptable ||
    severeInputInvalid ||
    !featureSet ||
    !validApplicationBoundary(original, featureSet, calibration)
  ) {
    return notAppliedResult(
      original,
      failureReason(noneAcceptable, severeInputInvalid),
    );
  }
  const candidateById = new Map(
    original.map((candidate) => [candidate.fontId, candidate]),
  );
  const allScored = featureSet.rows
    .map((row) => ({
      candidateId: row.candidateId,
      originalRank: row.originalRank,
      score: calibratedProbability(row.values, calibration),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        calibration.candidateIds.indexOf(left.candidateId) -
          calibration.candidateIds.indexOf(right.candidateId),
    );
  const scored = allScored.filter(
    ({ candidateId }) =>
      candidateById.get(candidateId)?.renderStatus === "rendered",
  );
  const winner = scored[0];
  if (!winner) {
    return notAppliedResult(original, "no_renderable_top3");
  }
  if (!Number.isFinite(winner.score)) {
    return notAppliedResult(original, "invalid_calibrated_score");
  }
  const policy = resolveOperatingPolicy(
    role,
    winner.score,
    calibration,
    allowFailedReleaseQuality,
  );
  if (!policy) {
    return notAppliedResult(original, "score_below_operating_point", true);
  }
  const renderedShortlist = scored.map(({ candidateId }) => candidateId);
  const renderedSet = new Set(renderedShortlist);
  const shortlist = [
    ...renderedShortlist,
    ...allScored
      .map(({ candidateId }) => candidateId)
      .filter((candidateId) => !renderedSet.has(candidateId)),
  ];
  const shortlistSet = new Set(shortlist);
  const reorderedIds = [
    ...shortlist,
    ...original
      .map(({ fontId }) => fontId)
      .filter((fontId) => !shortlistSet.has(fontId)),
  ];
  const ranked = reorderedIds.map((fontId, index) => {
    const candidate = candidateById.get(fontId);
    if (!candidate) throw new Error("Font selection candidate order drifted.");
    const calibrated = allScored.find((row) => row.candidateId === fontId);
    const renderable = candidate.renderStatus === "rendered";
    const isWinner = fontId === winner.candidateId;
    return {
      ...candidate,
      rank: index + 1,
      totalScore: renderable ? (calibrated?.score ?? 0) : 0,
      confidence: isWinner ? policy.point.risk_lcb : 0,
      reasonCodes: [
        ...candidate.reasonCodes,
        ...(calibrated && renderable
          ? ["supervised_top3_acceptability_rerank"]
          : []),
        ...(calibrated && !renderable
          ? ["supervised_candidate_excluded_unrenderable"]
          : []),
        ...(isWinner
          ? [
              `supervised_${policy.family}_operating_point`,
              "supervised_selection_score_threshold_passed",
            ]
          : ["selection_confidence_reserved_for_calibrated_winner"]),
      ],
    };
  });
  return {
    rankedCandidates: ranked,
    calibrationApplied: true,
    fallbackReason: null,
    operatingFamily: policy.family,
    selectionScore: winner.score,
  };
}

/**
 * Calibrate only the already-selected pixel-ranker winner. No calibrated
 * value is allowed to participate in candidate ordering or candidate scores.
 */
function applyRankPreservingConfidenceCalibration({
  rankedCandidates,
  role,
  calibration,
  featureSet,
  noneAcceptable,
  severeInputInvalid = false,
  allowFailedReleaseQuality = false,
}: Omit<FontMatchingSupervisedSelectionInput, "calibration"> &
  Readonly<{
    calibration: FontMatchingSelectionCalibrationV2;
  }>): FontMatchingSupervisedSelectionResult {
  const original = [...rankedCandidates].sort(compareOriginalCandidates);
  if (
    noneAcceptable ||
    severeInputInvalid ||
    !featureSet ||
    !validRankPreservingApplicationBoundary(original, featureSet, calibration)
  ) {
    return notAppliedResult(
      original,
      failureReason(noneAcceptable, severeInputInvalid),
    );
  }
  const winner = original[0];
  if (!winner || winner.renderStatus !== "rendered") {
    return notAppliedResult(original, "no_renderable_top3");
  }
  const score = rankPreservingConfidenceProbability(
    featureSet.top1RawScore,
    featureSet.top1RawMargin,
    calibration,
  );
  if (!Number.isFinite(score)) {
    return notAppliedResult(original, "invalid_calibrated_score");
  }
  const policy = resolveOperatingPolicy(
    role,
    score,
    calibration,
    allowFailedReleaseQuality,
  );
  if (!policy) {
    return notAppliedResult(original, "score_below_operating_point", true);
  }
  return {
    rankedCandidates: original.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      confidence: index === 0 ? policy.point.risk_lcb : 0,
      reasonCodes: [
        ...candidate.reasonCodes,
        "runtime_candidate_order_preserved",
        ...(index === 0
          ? [
              "rank_preserving_top1_confidence_calibrated",
              `supervised_${policy.family}_operating_point`,
              "supervised_selection_score_threshold_passed",
            ]
          : ["selection_confidence_reserved_for_runtime_winner"]),
      ],
    })),
    calibrationApplied: true,
    fallbackReason: null,
    operatingFamily: policy.family,
    selectionScore: score,
  };
}

function sameAutomaticFontRoleFamily(
  left: FontMatchingSemanticRole,
  right: FontMatchingSemanticRole,
): boolean {
  return roleFamily(left) === roleFamily(right);
}

/**
 * A role-family disagreement downgrades evidence to the sealed global cohort;
 * it does not erase a valid supervised choice.
 */
export function applySelectionRoleFamilyConflictPolicy(
  rankedCandidates: readonly RankedFontCandidateV2[],
  pixelRole: FontMatchingSemanticRole,
  combinedRole: FontMatchingSemanticRole,
  calibration: FontMatchingSelectionCalibration,
): RankedFontCandidateV2[] {
  return applySelectionRoleFamilyConflictConfidenceCap(
    rankedCandidates,
    pixelRole,
    combinedRole,
    calibration.operatingPoints.global.risk_lcb,
  );
}

/** Apply the sealed global confidence cap after the combined role is known. */
export function applySelectionRoleFamilyConflictConfidenceCap(
  rankedCandidates: readonly RankedFontCandidateV2[],
  pixelRole: FontMatchingSemanticRole,
  combinedRole: FontMatchingSemanticRole,
  globalRiskLowerConfidenceBound: number,
): RankedFontCandidateV2[] {
  if (sameAutomaticFontRoleFamily(pixelRole, combinedRole)) {
    return [...rankedCandidates];
  }
  const globalCap = Number.isFinite(globalRiskLowerConfidenceBound)
    ? Math.max(0, Math.min(1, globalRiskLowerConfidenceBound))
    : 0;
  return rankedCandidates.map((candidate) => ({
    ...candidate,
    totalScore: Math.min(candidate.totalScore, globalCap),
    confidence: Math.min(candidate.confidence, globalCap),
    reasonCodes: [
      ...candidate.reasonCodes,
      "pixel_llm_role_family_conflict_global_cap",
    ],
  }));
}

function calibratedProbability(
  values: readonly number[],
  calibration: FontMatchingSelectionCalibrationV1,
): number {
  let logit = calibration.logistic.intercept;
  for (let index = 0; index < values.length; index += 1) {
    const standardized =
      ((values[index] ?? 0) - (calibration.scaler.mean[index] ?? 0)) /
      (calibration.scaler.scale[index] ?? 1);
    logit += standardized * (calibration.logistic.coef[index] ?? 0);
  }
  if (logit >= 0) return 1 / (1 + Math.exp(-logit));
  const exponential = Math.exp(logit);
  return exponential / (1 + exponential);
}

function rankPreservingConfidenceProbability(
  top1RawScore: number,
  top1RawMargin: number,
  calibration: FontMatchingSelectionCalibrationV2,
): number {
  const [scoreCoefficient, marginCoefficient] =
    calibration.confidenceCalibration.coef;
  const logit =
    calibration.confidenceCalibration.intercept +
    top1RawScore * scoreCoefficient +
    top1RawMargin * marginCoefficient;
  if (logit >= 0) return 1 / (1 + Math.exp(-logit));
  const exponential = Math.exp(logit);
  return exponential / (1 + exponential);
}

type ResolvedOperatingPolicy = Readonly<{
  family: "body" | "variant" | "global";
  point: FontMatchingSelectionOperatingPoint;
}>;

function resolveOperatingPolicy(
  role: FontMatchingSemanticRole,
  score: number,
  calibration: FontMatchingSelectionCalibration,
  allowFailedReleaseQuality: boolean,
): ResolvedOperatingPolicy | null {
  const family = roleFamily(role);
  const familyPoint =
    family === "global" ? null : calibration.operatingPoints[family];
  const familyPreferredFloor =
    family === "variant"
      ? MINIMUM_VARIANT_PREFERRED_AT1
      : MINIMUM_GLOBAL_PREFERRED_AT1;
  if (
    usablePoint(familyPoint, familyPreferredFloor, allowFailedReleaseQuality) &&
    score >= familyPoint.selection_score_threshold
  ) {
    return { family, point: familyPoint };
  }
  const global = calibration.operatingPoints.global;
  if (
    !usablePoint(
      global,
      MINIMUM_GLOBAL_PREFERRED_AT1,
      allowFailedReleaseQuality,
    )
  ) {
    return null;
  }
  if (score >= global.selection_score_threshold) {
    return { family: "global", point: global };
  }
  return null;
}

function usablePoint(
  point: FontMatchingSelectionOperatingPoint | null,
  minimumPreferredAt1: number,
  allowFailedReleaseQuality: boolean,
): point is FontMatchingSelectionOperatingPoint & {
  selection_score_threshold: number;
} {
  return Boolean(
    point?.enabled &&
    point.coverage_floor_passed &&
    (allowFailedReleaseQuality ||
      (point.precision_target_passed &&
        point.preferred_at1 + 1e-12 >= minimumPreferredAt1)) &&
    point.risk_lcb > 0,
  );
}

function validApplicationBoundary(
  original: readonly RankedFontCandidateV2[],
  featureSet: FontMatchingSelectionFeatureSet,
  calibration: FontMatchingSelectionCalibrationV1,
): boolean {
  if (
    original.length !== calibration.candidateIds.length ||
    featureSet.rows.length !== 3 ||
    featureSet.originalCandidateOrder.length !== original.length
  ) {
    return false;
  }
  const originalIds = original.map(({ fontId }) => fontId);
  if (!sameStrings(originalIds, featureSet.originalCandidateOrder))
    return false;
  const expectedShortlist = originalIds.slice(0, 3);
  if (
    !sameStrings(
      featureSet.rows.map(({ candidateId }) => candidateId),
      expectedShortlist,
    )
  ) {
    return false;
  }
  return featureSet.rows.every(
    ({ values }) =>
      values.length === calibration.featureNames.length &&
      values.every(Number.isFinite),
  );
}

function validRankPreservingApplicationBoundary(
  original: readonly RankedFontCandidateV2[],
  featureSet: FontMatchingSelectionFeatureSet,
  calibration: FontMatchingSelectionCalibrationV2,
): boolean {
  if (
    original.length !== calibration.candidateIds.length ||
    featureSet.originalCandidateOrder.length !== original.length ||
    featureSet.rows.length !== 3 ||
    !Number.isFinite(featureSet.top1RawScore) ||
    !Number.isFinite(featureSet.top1RawMargin) ||
    featureSet.top1RawMargin < 0
  ) {
    return false;
  }
  const originalIds = original.map(({ fontId }) => fontId);
  return (
    sameStrings(originalIds, featureSet.originalCandidateOrder) &&
    sameStrings(
      featureSet.rows.map(({ candidateId }) => candidateId),
      originalIds.slice(0, 3),
    ) &&
    featureSet.rows.every(
      ({ values, originalRank }, index) =>
        values.length === 0 && originalRank === index + 1,
    )
  );
}

type SelectionFallbackReason = NonNullable<
  FontMatchingSupervisedSelectionResult["fallbackReason"]
>;

function notAppliedResult(
  candidates: readonly RankedFontCandidateV2[],
  reason: SelectionFallbackReason,
  preserveBaseEvidence = false,
): FontMatchingSupervisedSelectionResult {
  return {
    rankedCandidates: candidates.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      confidence: preserveBaseEvidence ? candidate.confidence : 0,
      reasonCodes: [
        ...candidate.reasonCodes,
        "calibration_not_applied",
        `supervised_selection_${reason}`,
      ],
    })),
    calibrationApplied: false,
    fallbackReason: reason,
    operatingFamily: null,
    selectionScore: null,
  };
}

function failureReason(
  noneAcceptable: boolean,
  severeInputInvalid: boolean,
): SelectionFallbackReason {
  if (noneAcceptable) return "none_acceptable";
  if (severeInputInvalid) return "severe_input_invalid";
  return "feature_boundary_invalid";
}

function roleFamily(
  role: FontMatchingSemanticRole,
): "body" | "variant" | "global" {
  if (BODY_ROLES.has(role)) return "body";
  if (VARIANT_ROLES.has(role)) return "variant";
  return "global";
}

function compareOriginalCandidates(
  left: RankedFontCandidateV2,
  right: RankedFontCandidateV2,
): number {
  return (
    left.rank - right.rank ||
    right.totalScore - left.totalScore ||
    compareStrings(left.fontId, right.fontId)
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
