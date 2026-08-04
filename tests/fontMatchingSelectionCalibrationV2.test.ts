import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RankedFontCandidateV2 } from "../src/shared/fontMatchingProfileTypes";
import {
  applySupervisedFontSelectionCalibration,
  isFontMatchingSelectionCalibrationDeploymentReady,
} from "../src/main/pipeline/fontMatchingSelectionCalibration";
import {
  candidateOrderSha256,
  FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES,
  FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_SCHEMA,
  FONT_MATCHING_RANK_PRESERVING_POLICY,
  FONT_MATCHING_SELECTION_CALIBRATION_RECORD,
  FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2,
  parseFontMatchingSelectionCalibration,
  type FontMatchingSelectionCalibrationV2,
  type FontMatchingSelectionRuntimeBindings,
} from "../src/main/pipeline/fontMatchingSelectionCalibrationContract";
import { buildFontMatchingSelectionFeatureSet } from "../src/main/pipeline/fontMatchingSelectionCalibrationFeatures";

const CANDIDATE_IDS = Array.from(
  { length: 21 },
  (_unused, index) => `font-${index.toString().padStart(2, "0")}`,
);
const BINDINGS: FontMatchingSelectionRuntimeBindings = {
  model_version: "rank-preserving-fixture-v1",
  runtime_contract_sha256: "1".repeat(64),
  candidate_order_sha256: candidateOrderSha256(CANDIDATE_IDS),
  encoder_sha256: "2".repeat(64),
  ranker_sha256: "3".repeat(64),
  prototype_features_sha256: "4".repeat(64),
  catalog_registry_sha256: "5".repeat(64),
};

describe("rank-preserving selection calibration v2", () => {
  it("parses the exact pixel-only confidence contract", () => {
    const parsed = parseFixture();

    expect(parsed?.schemaVersion).toBe(
      FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2,
    );
    expect(parsed?.rankingPolicy).toEqual(FONT_MATCHING_RANK_PRESERVING_POLICY);
    expect(parsed?.confidenceCalibration.feature_names).toEqual(
      FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES,
    );
  });

  it.each([
    "candidate_id::font-00",
    "role_body_mass",
    "gemma_role_probability",
    "genre_action_probability",
  ])("rejects forbidden confidence feature %s", (featureName) => {
    const record = fixtureRecord();
    const confidenceCalibration = record.confidence_calibration as {
      feature_names: string[];
    };
    confidenceCalibration.feature_names = ["top1_raw_score", featureName];

    expect(parseRecord(record)).toBeNull();
  });

  it("rejects any candidate reranking policy or non-identical OOF rank", () => {
    const reranking = fixtureRecord();
    const rankingPolicy = reranking.ranking_policy as {
      candidate_reranking: boolean;
    };
    rankingPolicy.candidate_reranking = true;
    expect(parseRecord(reranking)).toBeNull();

    const changedRank = fixtureRecord();
    changedRank.oof_report.rank_preservation.exact_top1_agreement = 0.99;
    expect(parseRecord(changedRank)).toBeNull();
  });

  it("accepts only the retired-Gugi-free active21 inventory", () => {
    const retired = fixtureRecord();
    retired.candidate_ids[18] = "gugi";
    retired.bindings.candidate_order_sha256 = candidateOrderSha256(
      retired.candidate_ids,
    );
    expect(
      parseFontMatchingSelectionCalibration(JSON.stringify(seal(retired)), {
        ...BINDINGS,
        candidate_order_sha256: retired.bindings.candidate_order_sha256,
      }),
    ).toBeNull();

    const short = fixtureRecord();
    short.candidate_ids.pop();
    short.bindings.candidate_order_sha256 = candidateOrderSha256(
      short.candidate_ids,
    );
    expect(
      parseFontMatchingSelectionCalibration(JSON.stringify(seal(short)), {
        ...BINDINGS,
        candidate_order_sha256: short.bindings.candidate_order_sha256,
      }),
    ).toBeNull();
  });

  it("binds OOF order evidence to the val-only pixel boundary", () => {
    const semanticLeak = fixtureRecord();
    semanticLeak.leakage_audit.semantic_feature_count = 1;
    expect(parseRecord(semanticLeak)).toBeNull();

    const operatingDrift = fixtureRecord();
    operatingDrift.oof_report.full_oof.global.risk_lcb = 0.81;
    expect(parseRecord(operatingDrift)).toBeNull();

    const rawWinnerDrift = fixtureRecord();
    rawWinnerDrift.training_boundary.raw_top1_sha256 = "d".repeat(64);
    expect(parseRecord(rawWinnerDrift)).toBeNull();
  });

  it("keeps the nested deployment quality gate mandatory", () => {
    const record = fixtureRecord();
    record.oof_report.nested_operating_evaluation.variant.preferred_at1 = 0.49;
    const parsed = parseRecord(record);

    expect(parsed).not.toBeNull();
    expect(
      parsed && isFontMatchingSelectionCalibrationDeploymentReady(parsed),
    ).toBe(false);
  });

  it("preserves runtime order and total scores while calibrating only top1 confidence", () => {
    const calibration = requiredCalibration();
    const input = candidates();
    const featureSet = buildFontMatchingSelectionFeatureSet(
      rawFeatures(),
      calibration,
    );
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: input,
      role: "dialogue",
      calibration,
      featureSet,
      noneAcceptable: false,
    });

    expect(result.calibrationApplied).toBe(true);
    expect(result.selectionScore).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(result.rankedCandidates.map(({ fontId }) => fontId)).toEqual(
      input.map(({ fontId }) => fontId),
    );
    expect(result.rankedCandidates.map(({ totalScore }) => totalScore)).toEqual(
      input.map(({ totalScore }) => totalScore),
    );
    expect(result.rankedCandidates[0]?.reasonCodes).toContain(
      "runtime_candidate_order_preserved",
    );
    expect(
      result.rankedCandidates
        .slice(1)
        .every(({ confidence }) => confidence === 0),
    ).toBe(true);
  });

  it("does not let role/style tensors affect v2 confidence", () => {
    const calibration = requiredCalibration();
    const firstFeatures = buildFontMatchingSelectionFeatureSet(
      rawFeatures(),
      calibration,
    );
    const secondFeatures = buildFontMatchingSelectionFeatureSet(
      {
        ...rawFeatures(),
        roleLogits: Array.from({ length: 14 }, (_unused, index) => index * 99),
        styleLogits: Array.from({ length: 10 }, () => Number.NaN),
      },
      calibration,
    );
    const apply = (featureSet: typeof firstFeatures) =>
      applySupervisedFontSelectionCalibration({
        rankedCandidates: candidates(),
        role: "dialogue",
        calibration,
        featureSet,
        noneAcceptable: false,
      });

    expect(firstFeatures).not.toBeNull();
    expect(secondFeatures).not.toBeNull();
    expect(apply(firstFeatures).selectionScore).toBe(
      apply(secondFeatures).selectionScore,
    );
  });
});

type FixtureRecord = ReturnType<typeof fixtureRecord>;

function fixtureRecord() {
  const point = operatingPoint();
  return {
    bindings: {
      ...BINDINGS,
      catalog_registry_record_sha256: "6".repeat(64),
      frozen_split_map_sha256: "7".repeat(64),
      master_manifest_sha256: "8".repeat(64),
      master_report_sha256: "9".repeat(64),
      master_split_map_sha256: "a".repeat(64),
      finals_sha256: "b".repeat(64),
    },
    candidate_ids: [...CANDIDATE_IDS],
    confidence_calibration: {
      schema_version: FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_SCHEMA,
      feature_names: [...FONT_MATCHING_RANK_PRESERVING_CONFIDENCE_FEATURES],
      coef: [0, 1],
      intercept: 0,
      c: 1,
      sigmoid: "1/(1+exp(-z))",
    },
    leakage_audit: {
      allowed_split: "val",
      candidate_reranking: false,
      hybrid_score_route_source: "pixel_shared_scores_role_downstream_only",
      non_val_label_rows_parsed: 0,
      pixel_only_confidence_features: true,
      pseudo_label_rows_used_for_fit: 0,
      semantic_feature_count: 0,
      test_rows_used_for_fit: 0,
      train_rows_used_for_fit: 0,
    },
    oof_report: {
      confidence_log_loss: 0.4,
      confidence_roc_auc: 0.7,
      final_C: 1,
      fit_implementation: {
        max_iter: 3000,
        penalty: "l2",
        raw_space_coefficients: true,
        solver: "lbfgs",
        standardization: "train_fold_population_mean_std_ddof0",
        tol: 1e-9,
      },
      folds: [],
      full_oof: {
        body: { ...point },
        variant: { ...point },
        global: { ...point },
      },
      nested_operating_evaluation: {
        body: { ...point },
        variant: { ...point },
        global: { ...point },
      },
      rank_preservation: {
        calibrated_top1_sha256: "c".repeat(64),
        changed_top1_count: 0,
        evaluated_sample_count: 90,
        exact_top1_agreement: 1,
        raw_top1_sha256: "c".repeat(64),
      },
      selected_C_values: [1],
    },
    operating_points: {
      body: { ...point },
      variant: { ...point },
      global: { ...point },
    },
    ranking_policy: { ...FONT_MATCHING_RANK_PRESERVING_POLICY },
    record_type: FONT_MATCHING_SELECTION_CALIBRATION_RECORD,
    schema_version: FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2,
    training_boundary: {
      raw_top1_sha256: "c".repeat(64),
      split: "val",
      supervision: { pseudo_labels_forbidden: true },
    },
  };
}

function operatingPoint() {
  return {
    acceptable_at1: 0.9,
    accepted_count: 90,
    cohort_count: 100,
    coverage: 0.9,
    coverage_floor_passed: true,
    coverage_target: 0.9,
    eligible_count: 90,
    enabled: true,
    hit_count: 81,
    miss_count: 9,
    none_abstained_count: 1,
    none_abstention_rate: 0.1,
    none_false_accept_count: 9,
    none_sample_count: 10,
    normal_accepted_count: 81,
    normal_sample_count: 90,
    overall_decision_accuracy: 0.82,
    precision_target: 0.85,
    precision_target_passed: true,
    preferred_at1: 0.6,
    risk_lcb: 0.83,
    selection_score_threshold: 0.7,
  };
}

function parseFixture(): FontMatchingSelectionCalibrationV2 | null {
  const parsed = parseRecord(fixtureRecord());
  return parsed?.schemaVersion === FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA_V2
    ? parsed
    : null;
}

function parseRecord(record: FixtureRecord) {
  return parseFontMatchingSelectionCalibration(
    JSON.stringify(seal(record)),
    BINDINGS,
  );
}

function requiredCalibration(): FontMatchingSelectionCalibrationV2 {
  const calibration = parseFixture();
  if (!calibration) throw new Error("v2 fixture failed to parse");
  return calibration;
}

function rawFeatures() {
  return {
    candidateIds: CANDIDATE_IDS,
    candidateScores: CANDIDATE_IDS.map((_unused, index) => 3 - index),
    runtimeTemperature: 1,
    noneLogit: -2,
    roleLogits: Array.from({ length: 14 }, () => 0),
    styleLogits: Array.from({ length: 10 }, () => 0),
    orientationLogits: [2, 1, 0, -1],
    viewGateWeights: [0.5, 0.25, 0.25],
    viewFeatures: [1, 0, 0, 1, 1, 1],
    featureDim: 2,
    prototypeFeatures: CANDIDATE_IDS.flatMap((_candidate, index) =>
      index % 2 === 0 ? [1, 0] : [0, 1],
    ),
    prototypeBags: CANDIDATE_IDS.map((candidateId, index) => ({
      candidateId,
      start: index,
      count: 1,
    })),
  };
}

function candidates(): RankedFontCandidateV2[] {
  return CANDIDATE_IDS.map((fontId, index) => ({
    rank: index + 1,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 1 - index / 100,
    roleFit: index / 100,
    layoutFit: null,
    glyphCoverage: null,
    workProfileFit: 0,
    userPreferenceFit: 0,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore: 1 / (index + 2),
    confidence: 1 / (index + 2),
    reasonCodes: ["verified_pixel_model"],
  }));
}

function seal<T extends Record<string, unknown>>(
  record: T,
): T & { record_sha256: string } {
  return {
    ...record,
    record_sha256: createHash("sha256")
      .update(canonicalJson(record))
      .digest("hex"),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
