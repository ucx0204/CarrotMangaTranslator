/* eslint-disable complexity, max-lines, max-lines-per-function -- sealed artifact validation stays in one auditable unit */
import { createHash } from "node:crypto";
import {
  canonicalRecordCoreFromJson,
  reconstructPythonSealedJsonWithoutNestedKey,
} from "./preservedJsonRecordSeal";

export const FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA =
  "font-matching-selection-calibration-v1";
export const FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2 =
  "font-matching-selection-calibration-v2";
export const FONT_MATCHING_SELECTION_CALIBRATION_RECORD =
  "font_matching_selection_calibration";
const FONT_MATCHING_SELECTION_FEATURE_SCHEMA =
  "font-matching-selection-features-v1";
export const FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_SCHEMA =
  "font-matching-rank-preserving-confidence-v1";

export const FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES = [
  "top1_raw_score",
  "top1_raw_margin",
] as const;

export const FONT_MATCHING_RANK_PRESERVING_POLICY = Object.freeze({
  mode: "preserve_runtime_candidate_order" as const,
  candidate_reranking: false as const,
  confidence_model: "top1_score_margin_platt" as const,
});

export const FONT_MATCHING_SELECTION_SUPPORTED_CANDIDATE_COUNTS = [
  15, 21, 22,
] as const;

export function isSupportedFontMatchingSelectionCandidateCount(
  value: number,
): value is (typeof FONT_MATCHING_SELECTION_SUPPORTED_CANDIDATE_COUNTS)[number] {
  return value === 15 || value === 21 || value === 22;
}

export const FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES = [
  "ranker_centered_logit",
  "ranker_z_logit",
  "ranker_probability",
  "ranker_log_probability",
  "ranker_rank_fraction",
  "ranker_gap_to_top",
  "ranker_is_top1",
  "ranker_is_top3",
  "ranker_entropy",
  "ranker_top3_mass",
  "ranker_margin_1_2",
  "none_logit",
  "none_probability",
  "role_body_mass",
  "role_variant_mass",
  "role_max_probability",
  "role_entropy",
  "style_serifness",
  "style_weight",
  "style_width",
  "style_slant",
  "style_handwritten",
  "style_irregularity",
  "style_energy",
  "orientation_horizontal",
  "orientation_vertical",
  "orientation_mixed",
  "orientation_unknown",
  "orientation_entropy",
  "view_gate_raw",
  "view_gate_context",
  "view_gate_glyph",
  "view_gate_entropy",
  "proto_mean_raw",
  "proto_mean_context",
  "proto_mean_glyph",
  "proto_lme_raw",
  "proto_lme_context",
  "proto_lme_glyph",
  "proto_gate_weighted_mean",
  "proto_cross_view_min",
  "proto_cross_view_std",
  "proto_rank_fraction",
  "proto_gap_to_best",
  "prototype_bag_count_fraction",
] as const;

type FontMatchingSelectionFeatureName =
  | (typeof FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES)[number]
  | `candidate_id::${string}`;

export type FontMatchingSelectionFeatureContract = Readonly<{
  candidate_scope: "original_onnx_top3_only";
  entropy: "-sum(p*ln(p))/ln(category_count), epsilon=1e-8";
  gap_sign: "candidate_minus_best_nonpositive";
  log_probability: "natural_log_of_temperature_softmax_plus_1e-8";
  prototype_lme: "ln(mean(exp(10*cosine)))/10";
  prototype_rank_basis: "view_gate_weighted_prototype_bag_mean_cosine";
  rank_fraction: "(zero_based_rank)/(candidate_count-1)";
  runtime_temperature_applied: true;
  schema_version: "font-matching-selection-features-v1";
  view_gate: "ranker_output_already_softmax_normalized";
  z_logit: "(logit-row_mean)/max(population_std_ddof0,1e-6)";
  prototype_bag_count_fraction: "bag_count/max_candidate_bag_count";
}>;

export const FONT_MATCHING_SELECTION_FEATURE_CONTRACT: FontMatchingSelectionFeatureContract =
  Object.freeze({
    candidate_scope: "original_onnx_top3_only",
    entropy: "-sum(p*ln(p))/ln(category_count), epsilon=1e-8",
    gap_sign: "candidate_minus_best_nonpositive",
    log_probability: "natural_log_of_temperature_softmax_plus_1e-8",
    prototype_lme: "ln(mean(exp(10*cosine)))/10",
    prototype_rank_basis: "view_gate_weighted_prototype_bag_mean_cosine",
    rank_fraction: "(zero_based_rank)/(candidate_count-1)",
    runtime_temperature_applied: true,
    schema_version: FONT_MATCHING_SELECTION_FEATURE_SCHEMA,
    view_gate: "ranker_output_already_softmax_normalized",
    z_logit: "(logit-row_mean)/max(population_std_ddof0,1e-6)",
    prototype_bag_count_fraction: "bag_count/max_candidate_bag_count",
  });

export type FontMatchingSelectionRuntimeBindings = Readonly<{
  model_version: string;
  runtime_contract_sha256: string;
  candidate_order_sha256: string;
  encoder_sha256: string;
  ranker_sha256: string;
  prototype_features_sha256: string;
  catalog_registry_sha256: string;
}>;

type FontMatchingSelectionBindings = FontMatchingSelectionRuntimeBindings &
  Readonly<{
    catalog_registry_record_sha256: string;
    frozen_split_map_sha256: string;
    master_manifest_sha256: string;
    master_report_sha256: string;
    master_split_map_sha256: string;
    finals_sha256: string;
  }>;

export type FontMatchingSelectionOperatingPoint = Readonly<{
  enabled: boolean;
  selection_score_threshold: number | null;
  coverage_target: number;
  coverage_floor_passed: boolean;
  precision_target: number;
  precision_target_passed: boolean;
  risk_lcb: number;
  cohort_count: number;
  accepted_count: number;
  eligible_count: number;
  normal_sample_count: number;
  normal_accepted_count: number;
  none_sample_count: number;
  none_false_accept_count: number;
  none_abstained_count: number;
  hit_count: number;
  miss_count: number;
  coverage: number;
  acceptable_at1: number;
  preferred_at1: number;
  overall_decision_accuracy: number;
  none_abstention_rate: number;
}>;

type FontMatchingSelectionCalibrationCommon = Readonly<{
  recordType: typeof FONT_MATCHING_SELECTION_CALIBRATION_RECORD;
  recordSha256: string;
  bindings: FontMatchingSelectionBindings;
  candidateIds: readonly string[];
  operatingPoints: Readonly<{
    body: FontMatchingSelectionOperatingPoint;
    variant: FontMatchingSelectionOperatingPoint;
    global: FontMatchingSelectionOperatingPoint;
  }>;
  leakageAudit: Readonly<Record<string, unknown>>;
  oofReport: Readonly<Record<string, unknown>>;
  trainingBoundary: Readonly<Record<string, unknown>>;
}>;

export type FontMatchingSelectionCalibrationV1 =
  FontMatchingSelectionCalibrationCommon &
    Readonly<{
      schemaVersion: typeof FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA;
      featureNames: readonly FontMatchingSelectionFeatureName[];
      featureContract: FontMatchingSelectionFeatureContract;
      scaler: Readonly<{ mean: readonly number[]; scale: readonly number[] }>;
      logistic: Readonly<{
        coef: readonly number[];
        intercept: number;
        c: number;
      }>;
      rankingPolicy?: undefined;
      confidenceCalibration?: undefined;
    }>;

type FontMatchingRankPreservingPolicy =
  typeof FONT_MATCHING_RANK_PRESERVING_POLICY;

type FontMatchingRankPreservingConfidenceCalibration = Readonly<{
  schema_version: typeof FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_SCHEMA;
  feature_names: typeof FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES;
  coef: readonly [number, number];
  intercept: number;
  c: number;
  sigmoid: "1/(1+exp(-z))";
}>;

export type FontMatchingSelectionCalibrationV2 =
  FontMatchingSelectionCalibrationCommon &
    Readonly<{
      schemaVersion: typeof FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2;
      rankingPolicy: FontMatchingRankPreservingPolicy;
      confidenceCalibration: FontMatchingRankPreservingConfidenceCalibration;
      featureNames?: undefined;
      featureContract?: undefined;
      scaler?: undefined;
      logistic?: undefined;
    }>;

export type FontMatchingSelectionCalibration =
  | FontMatchingSelectionCalibrationV1
  | FontMatchingSelectionCalibrationV2;

const V1_TOP_LEVEL_KEYS = [
  "bindings",
  "candidate_ids",
  "feature_contract",
  "feature_names",
  "leakage_audit",
  "logistic",
  "oof_report",
  "operating_points",
  "record_sha256",
  "record_type",
  "scaler",
  "schema_version",
  "training_boundary",
] as const;

const V2_TOP_LEVEL_KEYS = [
  "bindings",
  "candidate_ids",
  "confidence_calibration",
  "leakage_audit",
  "oof_report",
  "operating_points",
  "ranking_policy",
  "record_sha256",
  "record_type",
  "schema_version",
  "training_boundary",
] as const;

const BINDING_KEYS = [
  "candidate_order_sha256",
  "catalog_registry_record_sha256",
  "catalog_registry_sha256",
  "encoder_sha256",
  "finals_sha256",
  "frozen_split_map_sha256",
  "master_manifest_sha256",
  "master_report_sha256",
  "master_split_map_sha256",
  "model_version",
  "prototype_features_sha256",
  "ranker_sha256",
  "runtime_contract_sha256",
] as const;

const RUNTIME_BINDING_KEYS = [
  "candidate_order_sha256",
  "catalog_registry_sha256",
  "encoder_sha256",
  "model_version",
  "prototype_features_sha256",
  "ranker_sha256",
  "runtime_contract_sha256",
] as const;

const OPERATING_POINT_KEYS = [
  "acceptable_at1",
  "accepted_count",
  "cohort_count",
  "coverage",
  "coverage_floor_passed",
  "coverage_target",
  "eligible_count",
  "enabled",
  "hit_count",
  "miss_count",
  "none_abstained_count",
  "none_abstention_rate",
  "none_false_accept_count",
  "none_sample_count",
  "normal_accepted_count",
  "normal_sample_count",
  "overall_decision_accuracy",
  "precision_target",
  "precision_target_passed",
  "preferred_at1",
  "risk_lcb",
  "selection_score_threshold",
] as const;

/** Parse and verify a sealed calibration. Any schema drift returns null. */
export function parseFontMatchingSelectionCalibration(
  json: string | Uint8Array,
  expectedBindings: FontMatchingSelectionRuntimeBindings,
): FontMatchingSelectionCalibration | null {
  try {
    const text =
      typeof json === "string"
        ? json
        : new TextDecoder("utf-8", { fatal: true }).decode(json);
    const canonicalCore = canonicalRecordCoreFromJson(text);
    if (!canonicalCore) return null;
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    if (
      value.record_type !== FONT_MATCHING_SELECTION_CALIBRATION_RECORD ||
      !isSha256(value.record_sha256) ||
      value.record_sha256 !== sha256(canonicalCore)
    ) {
      return null;
    }
    if (value.schema_version === FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA) {
      return parseV1Calibration(value, expectedBindings);
    }
    if (
      value.schema_version === FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2
    ) {
      return parseV2Calibration(value, expectedBindings);
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function parseV1Calibration(
  value: Record<string, unknown>,
  expectedBindings: FontMatchingSelectionRuntimeBindings,
): FontMatchingSelectionCalibrationV1 | null {
  if (!hasExactKeys(value, V1_TOP_LEVEL_KEYS)) return null;
  const common = parseCommonCalibration(value, expectedBindings);
  if (!common) return null;
  const featureNames = parseFeatureNames(
    value.feature_names,
    common.candidateIds,
  );
  const featureContract = parseFeatureContract(value.feature_contract);
  if (!featureNames || !featureContract) return null;
  const scaler = parseScaler(value.scaler, featureNames.length);
  const logistic = parseLogistic(value.logistic, featureNames.length);
  if (!scaler || !logistic) return null;
  if (
    !validOofReport(value.oof_report as Record<string, unknown>, logistic.c)
  ) {
    return null;
  }
  return {
    ...common,
    schemaVersion: FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA,
    featureNames,
    featureContract,
    scaler,
    logistic,
  };
}

function parseV2Calibration(
  value: Record<string, unknown>,
  expectedBindings: FontMatchingSelectionRuntimeBindings,
): FontMatchingSelectionCalibrationV2 | null {
  if (!hasExactKeys(value, V2_TOP_LEVEL_KEYS)) return null;
  const common = parseCommonCalibration(value, expectedBindings);
  const rankingPolicy = parseRankPreservingPolicy(value.ranking_policy);
  const confidenceCalibration = parseRankPreservingConfidenceCalibration(
    value.confidence_calibration,
  );
  if (!common || !rankingPolicy || !confidenceCalibration) return null;
  if (
    common.candidateIds.length !== 21 ||
    common.candidateIds.includes("gugi")
  ) {
    return null;
  }
  if (
    !validRankPreservingOofReport(
      value.oof_report as Record<string, unknown>,
      confidenceCalibration.c,
    ) ||
    !validRankPreservingBoundaryEvidence(common)
  ) {
    return null;
  }
  return {
    ...common,
    schemaVersion: FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2,
    rankingPolicy,
    confidenceCalibration,
  };
}

function parseCommonCalibration(
  value: Record<string, unknown>,
  expectedBindings: FontMatchingSelectionRuntimeBindings,
): FontMatchingSelectionCalibrationCommon | null {
  const bindings = parseBindings(value.bindings, expectedBindings);
  const candidateIds = parseCandidateIds(value.candidate_ids);
  if (
    !bindings ||
    !candidateIds ||
    !isSupportedFontMatchingSelectionCandidateCount(candidateIds.length)
  ) {
    return null;
  }
  if (candidateOrderSha256(candidateIds) !== bindings.candidate_order_sha256) {
    return null;
  }
  const operatingPoints = parseOperatingPoints(value.operating_points);
  if (!operatingPoints) return null;
  if (!isRecord(value.leakage_audit) || !isRecord(value.oof_report))
    return null;
  if (!isRecord(value.training_boundary)) return null;
  if (!validNoTestFitBoundary(value.leakage_audit, value.training_boundary)) {
    return null;
  }
  return {
    recordType: FONT_MATCHING_SELECTION_CALIBRATION_RECORD,
    recordSha256: value.record_sha256 as string,
    bindings,
    candidateIds,
    operatingPoints,
    leakageAudit: value.leakage_audit,
    oofReport: value.oof_report,
    trainingBoundary: value.training_boundary,
  };
}

function parseRankPreservingPolicy(
  value: unknown,
): FontMatchingRankPreservingPolicy | null {
  if (!isRecord(value)) return null;
  const expected = FONT_MATCHING_RANK_PRESERVING_POLICY;
  const expectedRecord = expected as Readonly<Record<string, unknown>>;
  const keys = Object.keys(expected).sort();
  return hasExactKeys(value, keys) &&
    keys.every((key) => value[key] === expectedRecord[key])
    ? (value as FontMatchingRankPreservingPolicy)
    : null;
}

function parseRankPreservingConfidenceCalibration(
  value: unknown,
): FontMatchingRankPreservingConfidenceCalibration | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "c",
      "coef",
      "feature_names",
      "intercept",
      "schema_version",
      "sigmoid",
    ]) ||
    value.schema_version !== FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_SCHEMA ||
    !sameStrings(
      value.feature_names,
      FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES,
    ) ||
    value.sigmoid !== "1/(1+exp(-z))" ||
    !finiteNumber(value.intercept) ||
    !finiteNumber(value.c) ||
    value.c <= 0
  ) {
    return null;
  }
  const coef = finiteArray(
    value.coef,
    FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES.length,
  );
  if (!coef) return null;
  return {
    schema_version: FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_SCHEMA,
    feature_names: FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES,
    coef: [coef[0] as number, coef[1] as number],
    intercept: value.intercept,
    c: value.c,
    sigmoid: "1/(1+exp(-z))",
  };
}

function parseBindings(
  value: unknown,
  expected: FontMatchingSelectionRuntimeBindings,
): FontMatchingSelectionBindings | null {
  const expectedRecord: Record<string, unknown> = { ...expected };
  if (
    !hasExactKeys(expectedRecord, RUNTIME_BINDING_KEYS) ||
    !nonEmptyText(expected.model_version) ||
    !RUNTIME_BINDING_KEYS.filter((key) => key.endsWith("sha256")).every((key) =>
      isSha256(expected[key]),
    )
  ) {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, BINDING_KEYS)) return null;
  if (!nonEmptyText(value.model_version)) return null;
  for (const key of BINDING_KEYS.filter((key) => key.endsWith("sha256"))) {
    if (!isSha256(value[key])) return null;
  }
  const parsed = value as FontMatchingSelectionBindings;
  return Object.entries(expected).every(
    ([key, expectedValue]) =>
      parsed[key as keyof FontMatchingSelectionBindings] === expectedValue,
  )
    ? parsed
    : null;
}

function parseCandidateIds(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(nonEmptyText) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value;
}

function parseFeatureNames(
  value: unknown,
  candidateIds: readonly string[],
): readonly FontMatchingSelectionFeatureName[] | null {
  const expected = [
    ...FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
    ...candidateIds.map((candidateId) => `candidate_id::${candidateId}`),
  ];
  return sameStrings(value, expected)
    ? (value as FontMatchingSelectionFeatureName[])
    : null;
}

function parseFeatureContract(
  value: unknown,
): FontMatchingSelectionFeatureContract | null {
  if (!isRecord(value)) return null;
  const expected = FONT_MATCHING_SELECTION_FEATURE_CONTRACT;
  const expectedRecord = expected as Readonly<Record<string, unknown>>;
  const keys = Object.keys(expected).sort();
  if (!hasExactKeys(value, keys)) return null;
  return keys.every((key) => value[key] === expectedRecord[key])
    ? (value as FontMatchingSelectionFeatureContract)
    : null;
}

function parseScaler(
  value: unknown,
  featureCount: number,
): FontMatchingSelectionCalibrationV1["scaler"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["mean", "scale"])) return null;
  const mean = finiteArray(value.mean, featureCount);
  const scale = finiteArray(value.scale, featureCount);
  if (!mean || !scale || scale.some((entry) => entry <= 0)) return null;
  return { mean, scale };
}

function parseLogistic(
  value: unknown,
  featureCount: number,
): FontMatchingSelectionCalibrationV1["logistic"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["c", "coef", "intercept"])) {
    return null;
  }
  const coef = finiteArray(value.coef, featureCount);
  if (!coef || !finiteNumber(value.intercept) || !finiteNumber(value.c))
    return null;
  if (value.c <= 0) return null;
  return { coef, intercept: value.intercept, c: value.c };
}

function parseOperatingPoints(
  value: unknown,
): FontMatchingSelectionCalibrationCommon["operatingPoints"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["body", "global", "variant"])) {
    return null;
  }
  const body = parseOperatingPoint(value.body);
  const variant = parseOperatingPoint(value.variant);
  const global = parseOperatingPoint(value.global);
  return body &&
    variant &&
    global?.enabled &&
    global.coverage_floor_passed &&
    global.coverage_target >= 0.9
    ? { body, variant, global }
    : null;
}

function parseOperatingPoint(
  value: unknown,
): FontMatchingSelectionOperatingPoint | null {
  if (!isRecord(value) || !hasExactKeys(value, OPERATING_POINT_KEYS))
    return null;
  const probabilityKeys = [
    "acceptable_at1",
    "coverage",
    "coverage_target",
    "none_abstention_rate",
    "overall_decision_accuracy",
    "precision_target",
    "preferred_at1",
    "risk_lcb",
  ] as const;
  if (!probabilityKeys.every((key) => probability(value[key]))) return null;
  if ((value.coverage_target as number) < 0.9) return null;
  const countKeys = [
    "accepted_count",
    "cohort_count",
    "eligible_count",
    "hit_count",
    "miss_count",
    "none_abstained_count",
    "none_false_accept_count",
    "none_sample_count",
    "normal_accepted_count",
    "normal_sample_count",
  ] as const;
  if (!countKeys.every((key) => nonNegativeInteger(value[key]))) return null;
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.coverage_floor_passed !== "boolean" ||
    typeof value.precision_target_passed !== "boolean"
  ) {
    return null;
  }
  const point = value as FontMatchingSelectionOperatingPoint;
  if (
    point.eligible_count !== point.normal_sample_count ||
    point.cohort_count !==
      point.normal_sample_count + point.none_sample_count ||
    point.normal_accepted_count > point.normal_sample_count ||
    point.none_false_accept_count > point.none_sample_count ||
    point.none_abstained_count !==
      point.none_sample_count - point.none_false_accept_count ||
    point.accepted_count !==
      point.normal_accepted_count + point.none_false_accept_count ||
    point.hit_count > point.normal_accepted_count ||
    point.hit_count + point.miss_count !== point.accepted_count ||
    (point.enabled &&
      (point.accepted_count === 0 ||
        point.normal_sample_count === 0 ||
        !probability(point.selection_score_threshold))) ||
    (!point.enabled &&
      (point.accepted_count !== 0 || point.selection_score_threshold !== null))
  ) {
    return null;
  }
  const coverage =
    point.normal_accepted_count / Math.max(1, point.normal_sample_count);
  const accuracy = point.hit_count / Math.max(1, point.accepted_count);
  const overallDecisionAccuracy =
    (point.hit_count + point.none_abstained_count) /
    Math.max(1, point.cohort_count);
  const noneAbstentionRate = point.none_sample_count
    ? point.none_abstained_count / point.none_sample_count
    : 1;
  if (
    !closeEnough(point.coverage, coverage) ||
    !closeEnough(point.acceptable_at1, accuracy) ||
    !closeEnough(point.overall_decision_accuracy, overallDecisionAccuracy) ||
    !closeEnough(point.none_abstention_rate, noneAbstentionRate) ||
    point.preferred_at1 > point.acceptable_at1 + 1e-12 ||
    point.coverage_floor_passed !==
      (point.normal_sample_count > 0 &&
        point.coverage + 1e-12 >= point.coverage_target) ||
    point.precision_target_passed !==
      (point.enabled && point.acceptable_at1 + 1e-12 >= point.precision_target)
  ) {
    return null;
  }
  return point;
}

function validNoTestFitBoundary(
  leakageAudit: Record<string, unknown>,
  trainingBoundary: Record<string, unknown>,
): boolean {
  return (
    leakageAudit.test_rows_used_for_fit === 0 &&
    leakageAudit.train_rows_used_for_fit === 0 &&
    leakageAudit.non_val_label_rows_parsed === 0 &&
    leakageAudit.pseudo_label_rows_used_for_fit === 0 &&
    [leakageAudit, trainingBoundary].every((record) =>
      Object.entries(record).every(
        ([key, value]) =>
          !/(?:test|frozen_test).*(?:fit|train)/iu.test(key) || value === 0,
      ),
    )
  );
}

function validOofReport(
  report: Record<string, unknown>,
  logisticC: number,
): boolean {
  if (
    !hasExactKeys(report, [
      "candidate_log_loss",
      "candidate_roc_auc",
      "final_C",
      "fit_implementation",
      "folds",
      "full_oof",
      "nested_operating_evaluation",
      "selected_C_values",
    ]) ||
    !finiteNumber(report.candidate_log_loss) ||
    report.candidate_log_loss < 0 ||
    !probability(report.candidate_roc_auc) ||
    !finiteNumber(report.final_C) ||
    !closeEnough(report.final_C, logisticC) ||
    !Array.isArray(report.folds) ||
    !Array.isArray(report.selected_C_values) ||
    !report.selected_C_values.every(
      (value) => finiteNumber(value) && value > 0,
    ) ||
    !isRecord(report.full_oof) ||
    !isRecord(report.nested_operating_evaluation)
  ) {
    return false;
  }
  const fullOof = parseOperatingPoints(report.full_oof);
  const nestedOperating = parseOperatingPoints(
    report.nested_operating_evaluation,
  );
  if (!fullOof || !nestedOperating) return false;
  const implementation = report.fit_implementation;
  return Boolean(
    isRecord(implementation) &&
    hasExactKeys(implementation, [
      "max_iter",
      "penalty",
      "solver",
      "standardization",
      "tol",
    ]) &&
    implementation.solver === "lbfgs" &&
    implementation.penalty === "l2" &&
    implementation.max_iter === 3000 &&
    implementation.tol === 1e-9 &&
    implementation.standardization === "train_fold_population_mean_std_ddof0",
  );
}

function validRankPreservingOofReport(
  report: Record<string, unknown>,
  logisticC: number,
): boolean {
  if (
    !hasExactKeys(report, [
      "confidence_log_loss",
      "confidence_roc_auc",
      "final_C",
      "fit_implementation",
      "folds",
      "full_oof",
      "nested_operating_evaluation",
      "rank_preservation",
      "selected_C_values",
    ]) ||
    !finiteNumber(report.confidence_log_loss) ||
    report.confidence_log_loss < 0 ||
    !probability(report.confidence_roc_auc) ||
    !finiteNumber(report.final_C) ||
    !closeEnough(report.final_C, logisticC) ||
    !Array.isArray(report.folds) ||
    !Array.isArray(report.selected_C_values) ||
    !report.selected_C_values.every(
      (value) => finiteNumber(value) && value > 0,
    ) ||
    !isRecord(report.full_oof) ||
    !isRecord(report.nested_operating_evaluation)
  ) {
    return false;
  }
  const rankPreservation = report.rank_preservation;
  if (
    !isRecord(rankPreservation) ||
    !hasExactKeys(rankPreservation, [
      "calibrated_top1_sha256",
      "changed_top1_count",
      "evaluated_sample_count",
      "exact_top1_agreement",
      "raw_top1_sha256",
    ]) ||
    !isSha256(rankPreservation.raw_top1_sha256) ||
    !isSha256(rankPreservation.calibrated_top1_sha256) ||
    rankPreservation.raw_top1_sha256 !==
      rankPreservation.calibrated_top1_sha256 ||
    rankPreservation.changed_top1_count !== 0 ||
    !nonNegativeInteger(rankPreservation.evaluated_sample_count) ||
    rankPreservation.evaluated_sample_count === 0 ||
    rankPreservation.exact_top1_agreement !== 1
  ) {
    return false;
  }
  if (
    !parseOperatingPoints(report.full_oof) ||
    !parseOperatingPoints(report.nested_operating_evaluation)
  ) {
    return false;
  }
  const implementation = report.fit_implementation;
  return Boolean(
    isRecord(implementation) &&
    hasExactKeys(implementation, [
      "max_iter",
      "penalty",
      "raw_space_coefficients",
      "solver",
      "standardization",
      "tol",
    ]) &&
    implementation.solver === "lbfgs" &&
    implementation.penalty === "l2" &&
    implementation.raw_space_coefficients === true &&
    implementation.max_iter === 3000 &&
    implementation.tol === 1e-9 &&
    implementation.standardization === "train_fold_population_mean_std_ddof0",
  );
}

function validRankPreservingBoundaryEvidence(
  calibration: FontMatchingSelectionCalibrationCommon,
): boolean {
  const leakage = calibration.leakageAudit;
  const oof = calibration.oofReport;
  const training = calibration.trainingBoundary;
  const supervision = training.supervision;
  const rankPreservation = oof.rank_preservation;
  return Boolean(
    leakage.allowed_split === "val" &&
    leakage.candidate_reranking === false &&
    leakage.pixel_only_confidence_features === true &&
    leakage.semantic_feature_count === 0 &&
    leakage.hybrid_score_route_source ===
      "pixel_shared_scores_role_downstream_only" &&
    training.split === "val" &&
    isSha256(training.raw_top1_sha256) &&
    isRecord(supervision) &&
    supervision.pseudo_labels_forbidden === true &&
    isRecord(rankPreservation) &&
    training.raw_top1_sha256 === rankPreservation.raw_top1_sha256 &&
    canonicalJson(oof.full_oof) === canonicalJson(calibration.operatingPoints),
  );
}

export function candidateOrderSha256(candidateIds: readonly string[]): string {
  return sha256(`${candidateIds.join("\n")}\n`);
}

const BASE_RUNTIME_ASSET_FILES = [
  "auto-match-active-catalog.json",
  "encoder.onnx",
  "prototype-features.f32",
  "ranker.onnx",
] as const;

const EVALUATION_ONLY_CONTRACT_KEY = "evaluation_only_runtime";
const V8_RUNTIME_PACKAGING_KEY = "v8_runtime_packaging";
const EVALUATION_ONLY_SCHEMA = "font-matching-evaluation-only-runtime-v1";
const EVALUATION_ONLY_PACKAGING_KEYS = [
  "evaluation_only",
  "loader_opt_in_required",
  "non_promotable",
  "qa_only",
  "release_approved",
] as const;

function evaluationOnlyContractMode(
  contract: Record<string, unknown>,
): boolean | null {
  const evaluation = contract[EVALUATION_ONLY_CONTRACT_KEY];
  const packaging = contract[V8_RUNTIME_PACKAGING_KEY];
  const packagingFlagsPresent =
    isRecord(packaging) &&
    EVALUATION_ONLY_PACKAGING_KEYS.some((key) => key in packaging);
  if (
    (evaluation === undefined || evaluation === null) &&
    !packagingFlagsPresent
  ) {
    return false;
  }
  if (!isRecord(evaluation) || !isRecord(packaging)) return null;
  const expectedEvaluation: Readonly<Record<string, unknown>> = {
    evaluation_only: true,
    loader_opt_in_required: "allowQaOnlyRuntime",
    non_promotable: true,
    quality_gate_bypassed: true,
    release_acceptance_forbidden: true,
    release_approved: false,
    schema_version: EVALUATION_ONLY_SCHEMA,
  };
  const expectedPackaging: Readonly<Record<string, unknown>> = {
    evaluation_only: true,
    loader_opt_in_required: "allowQaOnlyRuntime",
    non_promotable: true,
    qa_only: true,
    release_approved: false,
  };
  return hasExactKeys(evaluation, Object.keys(expectedEvaluation)) &&
    Object.entries(expectedEvaluation).every(
      ([key, value]) => evaluation[key] === value,
    ) &&
    Object.entries(expectedPackaging).every(
      ([key, value]) => packaging[key] === value,
    ) &&
    packaging.quality_gate_bypassed === true &&
    (contract.release_acceptance === undefined ||
      contract.release_acceptance === null)
    ? true
    : null;
}

/**
 * Recover the exact pre-attachment runtime-contract file digest used by the
 * Python calibration builder. The attachment step adds one artifact
 * descriptor and reseals the contract; removing it and repeating the same
 * sorted/indented serialization recreates the source binding without trusting
 * an extra mutable hash field.
 */
export function reconstructFontMatchingSourceRuntimeContractSha256(
  attachedContract: Record<string, unknown>,
  attachedContractJson?: string,
): string | null {
  const artifacts = isRecord(attachedContract.artifacts)
    ? attachedContract.artifacts
    : null;
  const expectedAttachedAssets = [
    ...BASE_RUNTIME_ASSET_FILES,
    "selection-calibration.json",
  ].sort();
  if (
    !artifacts ||
    !sameStrings(Object.keys(artifacts).sort(), expectedAttachedAssets)
  ) {
    return null;
  }
  const evaluationOnly = evaluationOnlyContractMode(attachedContract);
  if (evaluationOnly === null) return null;
  if (attachedContractJson !== undefined) {
    const reconstructed = reconstructPythonSealedJsonWithoutNestedKey(
      attachedContractJson,
      "artifacts",
      "selection-calibration.json",
      "record_sha256",
      [
        "release_acceptance",
        ...(evaluationOnly ? [EVALUATION_ONLY_CONTRACT_KEY] : []),
      ],
      evaluationOnly
        ? [
            {
              objectKey: V8_RUNTIME_PACKAGING_KEY,
              removedKeys: EVALUATION_ONLY_PACKAGING_KEYS,
              literalOverrides: { quality_gate_bypassed: "false" },
            },
          ]
        : [],
    );
    if (!reconstructed) return null;
    try {
      const parsed: unknown = JSON.parse(reconstructed);
      if (!isRecord(parsed) || !isRecord(parsed.artifacts)) return null;
      if (
        !sameStrings(
          Object.keys(parsed.artifacts).sort(),
          [...BASE_RUNTIME_ASSET_FILES].sort(),
        )
      ) {
        return null;
      }
    } catch (_error) {
      return null;
    }
    return sha256(reconstructed);
  }
  const sourceArtifacts = Object.fromEntries(
    Object.entries(artifacts).filter(
      ([fileName]) => fileName !== "selection-calibration.json",
    ),
  );
  const sourceContract = evaluationOnly
    ? Object.fromEntries(
        Object.entries(attachedContract)
          .filter(([key]) => key !== EVALUATION_ONLY_CONTRACT_KEY)
          .map(([key, value]) => {
            if (key !== V8_RUNTIME_PACKAGING_KEY || !isRecord(value)) {
              return [key, value];
            }
            return [
              key,
              {
                ...Object.fromEntries(
                  Object.entries(value).filter(
                    ([packagingKey]) =>
                      !EVALUATION_ONLY_PACKAGING_KEYS.includes(
                        packagingKey as (typeof EVALUATION_ONLY_PACKAGING_KEYS)[number],
                      ),
                  ),
                ),
                quality_gate_bypassed: false,
              },
            ];
          }),
      )
    : attachedContract;
  const sourceCore = Object.fromEntries(
    Object.entries(sourceContract)
      .filter(
        ([key]) => key !== "record_sha256" && key !== "release_acceptance",
      )
      .map(([key, value]) => [
        key,
        key === "artifacts" ? sourceArtifacts : value,
      ]),
  );
  const sourceRecord = {
    ...sourceCore,
    record_sha256: sha256(canonicalJson(sourceCore)),
  };
  return sha256(`${JSON.stringify(sortJsonValue(sourceRecord), null, 2)}\n`);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function finiteArray(value: unknown, length: number): readonly number[] | null {
  return Array.isArray(value) &&
    value.length === length &&
    value.every(finiteNumber)
    ? value
    : null;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return sameStrings(actual, expected);
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function probability(value: unknown): value is number {
  return finiteNumber(value) && value >= 0 && value <= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
