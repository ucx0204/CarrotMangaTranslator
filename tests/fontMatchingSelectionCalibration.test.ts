import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  FontMatchingSemanticRole,
  RankedFontCandidateV2,
} from "../src/shared/fontMatchingProfileTypes";
import {
  applySelectionRoleFamilyConflictPolicy,
  applySupervisedFontSelectionCalibration,
  isFontMatchingSelectionCalibrationDeploymentReady,
} from "../src/main/pipeline/fontMatchingSelectionCalibration";
import {
  candidateOrderSha256,
  FONT_MATCHING_SELECTION_CALIBRATION_RECORD,
  FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA,
  FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
  FONT_MATCHING_SELECTION_FEATURE_CONTRACT,
  parseFontMatchingSelectionCalibration,
  reconstructFontMatchingSourceRuntimeContractSha256,
  type FontMatchingSelectionCalibration,
  type FontMatchingSelectionRuntimeBindings,
} from "../src/main/pipeline/fontMatchingSelectionCalibrationContract";
import {
  buildFontMatchingSelectionFeatureSet,
  type FontMatchingSelectionFeatureSet,
} from "../src/main/pipeline/fontMatchingSelectionCalibrationFeatures";
import { canonicalRecordCoreFromJson } from "../src/main/pipeline/preservedJsonRecordSeal";

const CANDIDATE_IDS = Array.from(
  { length: 15 },
  (_unused, index) => `font-${index.toString().padStart(2, "0")}`,
);
const FEATURE_NAMES = [
  ...FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
  ...CANDIDATE_IDS.map((candidateId) => `candidate_id::${candidateId}`),
];
const BINDINGS: FontMatchingSelectionRuntimeBindings = {
  model_version: "fixture-runtime-v1",
  runtime_contract_sha256: "1".repeat(64),
  candidate_order_sha256: candidateOrderSha256(CANDIDATE_IDS),
  encoder_sha256: "2".repeat(64),
  ranker_sha256: "3".repeat(64),
  prototype_features_sha256: "4".repeat(64),
  catalog_registry_sha256: "5".repeat(64),
};

describe("font matching selection calibration contract", () => {
  it("reconstructs the Python-sealed source runtime contract file hash", () => {
    const files = [
      "auto-match-active-catalog.json",
      "encoder.onnx",
      "prototype-features.f32",
      "ranker.onnx",
      "selection-calibration.json",
    ];
    const attachedContract = {
      schema_version: "font-matching-runtime-artifact-v1",
      record_type: "font_matching_runtime_artifact",
      record_sha256: "f".repeat(64),
      model_version: "fixture-runtime-v1",
      artifacts: Object.fromEntries(
        files.map((file, index) => [
          file,
          {
            byte_size: index + 1,
            file,
            sha256: `${index + 1}`.repeat(64),
          },
        ]),
      ),
    };

    expect(
      reconstructFontMatchingSourceRuntimeContractSha256(attachedContract),
    ).toBe("0c6626f30e0f183164da079bc72077d5fc00cf9e161fcd829dbf6c85e43dd1a6");
    delete attachedContract.artifacts["selection-calibration.json"];
    expect(
      reconstructFontMatchingSourceRuntimeContractSha256(attachedContract),
    ).toBeNull();
  });

  it("reconstructs source bytes without normalizing Python float lexemes", () => {
    const descriptor = (file: string, index: number) => ({
      byte_size: index + 1,
      file,
      sha256: `${index + 1}`.repeat(64),
    });
    const baseFiles = [
      "auto-match-active-catalog.json",
      "encoder.onnx",
      "prototype-features.f32",
      "ranker.onnx",
    ];
    const sourceCore = {
      artifacts: Object.fromEntries(
        baseFiles.map((file, index) => [file, descriptor(file, index)]),
      ),
      calibration: { temperature: 1, tiny: 0.000001266 },
      model_version: "fixture-runtime-v1",
      record_type: "font_matching_runtime_artifact",
      schema_version: "font-matching-runtime-artifact-v1",
    };
    const attachedCore = {
      ...sourceCore,
      artifacts: {
        ...sourceCore.artifacts,
        "selection-calibration.json": descriptor(
          "selection-calibration.json",
          4,
        ),
      },
    };
    const sourceJson = pythonRuntimeContractJson(sourceCore);
    const attachedJson = pythonRuntimeContractJson(attachedCore);
    const attached = JSON.parse(attachedJson) as Record<string, unknown>;

    expect(attachedJson).toContain('"temperature": 1.0');
    expect(attachedJson).toContain('"tiny": 1.266e-06');
    expect(
      reconstructFontMatchingSourceRuntimeContractSha256(
        attached,
        attachedJson,
      ),
    ).toBe(createHash("sha256").update(sourceJson).digest("hex"));
  });

  it("excludes release_acceptance when reconstructing a release contract binding", () => {
    const descriptor = (file: string, index: number) => ({
      byte_size: index + 1,
      file,
      sha256: `${index + 1}`.repeat(64),
    });
    const baseFiles = [
      "auto-match-active-catalog.json",
      "encoder.onnx",
      "prototype-features.f32",
      "ranker.onnx",
    ];
    const sourceCore = {
      artifacts: Object.fromEntries(
        baseFiles.map((file, index) => [file, descriptor(file, index)]),
      ),
      calibration: { temperature: 1, none_threshold: 0.5 },
      model_version: "fixture-runtime-v1",
      record_type: "font_matching_runtime_artifact",
      // release_evaluation is part of the pre-calibration source contract; the
      // Python sealer does not pop it, so the binding hash includes it.
      release_evaluation: { status: "source_quality_gate_passed" },
      schema_version: "font-matching-runtime-artifact-v2",
    };
    const attachedCore = {
      ...sourceCore,
      artifacts: {
        ...sourceCore.artifacts,
        "selection-calibration.json": descriptor(
          "selection-calibration.json",
          4,
        ),
      },
      // A promoted release contract carries release evidence that the Python
      // calibration sealer pops before resealing; it must not change the binding.
      release_acceptance: {
        qa_runs: [{ cohort: "baseline40", verdict: "accepted" }],
        r5_snapshot_evaluations: ["e", "f"],
      },
      release_evaluation: { status: "source_quality_gate_passed" },
    };
    const sourceJson = pythonRuntimeContractJson(sourceCore);
    const attachedJson = pythonRuntimeContractJson(attachedCore);
    const attached = JSON.parse(attachedJson) as Record<string, unknown>;

    expect("release_acceptance" in attached).toBe(true);
    expect(
      reconstructFontMatchingSourceRuntimeContractSha256(
        attached,
        attachedJson,
      ),
    ).toBe(createHash("sha256").update(sourceJson).digest("hex"));
  });

  it("parses the sealed legacy 45+15 feature contract and exact bindings", () => {
    const parsed = parseFixture();

    expect(parsed?.featureNames).toEqual(FEATURE_NAMES);
    expect(parsed?.candidateIds).toEqual(CANDIDATE_IDS);
    expect(parsed?.operatingPoints.global.coverage).toBe(0.9);
    expect(
      parsed && isFontMatchingSelectionCalibrationDeploymentReady(parsed),
    ).toBe(true);
  });

  it("parses and materializes the sealed student 45+22 feature contract", () => {
    const studentCandidateIds = Array.from(
      { length: 22 },
      (_unused, index) => `student-font-${index.toString().padStart(2, "0")}`,
    );
    const studentBindings: FontMatchingSelectionRuntimeBindings = {
      ...BINDINGS,
      model_version: "manga-font-student-runtime-v1-fixture",
      candidate_order_sha256: candidateOrderSha256(studentCandidateIds),
    };
    const record = fixtureRecord();
    record.bindings.model_version = studentBindings.model_version;
    record.bindings.candidate_order_sha256 =
      studentBindings.candidate_order_sha256;
    record.candidate_ids = studentCandidateIds;
    record.feature_names = [
      ...FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
      ...studentCandidateIds.map(
        (candidateId) => `candidate_id::${candidateId}`,
      ),
    ];
    record.scaler.mean = record.feature_names.map(() => 0);
    record.scaler.scale = record.feature_names.map(() => 1);
    record.logistic.coef = record.feature_names.map(() => 0);
    const calibration = parseFontMatchingSelectionCalibration(
      JSON.stringify(seal(record)),
      studentBindings,
    );

    expect(calibration?.candidateIds).toEqual(studentCandidateIds);
    const raw = {
      ...rawFeatures(),
      candidateIds: studentCandidateIds,
      candidateScores: studentCandidateIds.map((_unused, index) => 22 - index),
      prototypeFeatures: studentCandidateIds.flatMap((_candidate, index) =>
        index % 2 === 0 ? [1, 0] : [0, 1],
      ),
      prototypeBags: studentCandidateIds.map((candidateId, index) => ({
        candidateId,
        start: index,
        count: 1,
      })),
    };
    const features = calibration
      ? buildFontMatchingSelectionFeatureSet(raw, calibration)
      : null;

    expect(features?.rows).toHaveLength(3);
    expect(features?.rows[0]?.values).toHaveLength(45 + 22);
    expect(features?.originalCandidateOrder).toEqual(studentCandidateIds);
  });

  it("parses the retired-Gugi active21 feature contract", () => {
    const activeCandidateIds = Array.from(
      { length: 21 },
      (_unused, index) => `active-font-${index.toString().padStart(2, "0")}`,
    );
    const activeBindings: FontMatchingSelectionRuntimeBindings = {
      ...BINDINGS,
      model_version: "manga-font-v7-active21-fixture",
      candidate_order_sha256: candidateOrderSha256(activeCandidateIds),
    };
    const record = fixtureRecord();
    record.bindings.model_version = activeBindings.model_version;
    record.bindings.candidate_order_sha256 =
      activeBindings.candidate_order_sha256;
    record.candidate_ids = activeCandidateIds;
    record.feature_names = [
      ...FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
      ...activeCandidateIds.map(
        (candidateId) => `candidate_id::${candidateId}`,
      ),
    ];
    record.scaler.mean = record.feature_names.map(() => 0);
    record.scaler.scale = record.feature_names.map(() => 1);
    record.logistic.coef = record.feature_names.map(() => 0);

    const calibration = parseFontMatchingSelectionCalibration(
      JSON.stringify(seal(record)),
      activeBindings,
    );

    expect(calibration?.candidateIds).toEqual(activeCandidateIds);
    expect(calibration?.featureNames).toHaveLength(45 + 21);
  });

  it("rejects a sealed candidate inventory outside legacy15/active21/student22", () => {
    const unsupportedIds = CANDIDATE_IDS.slice(0, 14);
    const unsupportedBindings: FontMatchingSelectionRuntimeBindings = {
      ...BINDINGS,
      candidate_order_sha256: candidateOrderSha256(unsupportedIds),
    };
    const record = fixtureRecord();
    record.bindings.candidate_order_sha256 =
      unsupportedBindings.candidate_order_sha256;
    record.candidate_ids = unsupportedIds;
    record.feature_names = [
      ...FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES,
      ...unsupportedIds.map((candidateId) => `candidate_id::${candidateId}`),
    ];
    record.scaler.mean = record.feature_names.map(() => 0);
    record.scaler.scale = record.feature_names.map(() => 1);
    record.logistic.coef = record.feature_names.map(() => 0);

    expect(
      parseFontMatchingSelectionCalibration(
        JSON.stringify(seal(record)),
        unsupportedBindings,
      ),
    ).toBeNull();
  });

  it.each([
    [
      "unknown formula",
      (record: FixtureRecord) => {
        (record.feature_contract as Record<string, unknown>).gap_sign =
          "best_minus_candidate";
      },
    ],
    [
      "feature order",
      (record: FixtureRecord) => {
        record.feature_names.reverse();
      },
    ],
    [
      "test leakage",
      (record: FixtureRecord) => {
        record.leakage_audit.test_rows_used_for_fit = 1;
      },
    ],
    [
      "non-finite coefficient",
      (record: FixtureRecord) => {
        record.logistic.coef[0] = Number.NaN;
      },
    ],
  ])("fails closed on %s", (_label, mutate) => {
    const record = fixtureRecord();
    mutate(record);

    expect(parseRecord(record)).toBeNull();
  });

  it("rejects a validly resealed record bound to a different runtime", () => {
    const record = fixtureRecord();
    record.bindings.ranker_sha256 = "a".repeat(64);

    expect(parseRecord(record)).toBeNull();
  });

  it("rejects an altered payload whose record seal was not recomputed", () => {
    const sealed = seal(fixtureRecord());
    sealed.logistic.intercept = 9;

    expect(
      parseFontMatchingSelectionCalibration(JSON.stringify(sealed), BINDINGS),
    ).toBeNull();
  });

  it("verifies Python json.dumps float spellings without weakening the seal", () => {
    const record = fixtureRecord();
    const core = pythonStyleCanonicalJson(record);
    const recordSha256 = createHash("sha256").update(core).digest("hex");
    const pythonSealedJson = pythonStyleCanonicalJson({
      ...record,
      record_sha256: recordSha256,
    });

    expect(
      parseFontMatchingSelectionCalibration(pythonSealedJson, BINDINGS),
    ).not.toBeNull();
  });
});

describe("font matching selection feature parity", () => {
  it("constructs the fixed formulas and only emits the original ONNX top3", () => {
    const calibration = requiredCalibration();
    const featureSet = buildFontMatchingSelectionFeatureSet(
      rawFeatures(),
      calibration,
    );

    expect(featureSet?.rows.map(({ candidateId }) => candidateId)).toEqual(
      CANDIDATE_IDS.slice(0, 3),
    );
    const first = featureMap(featureSet?.rows[0]?.values ?? []);
    const second = featureMap(featureSet?.rows[1]?.values ?? []);
    expect(first.ranker_gap_to_top).toBeCloseTo(0, 12);
    expect(second.ranker_gap_to_top).toBeCloseTo(-1, 12);
    expect(second.ranker_rank_fraction).toBeCloseTo(1 / 14, 12);
    expect(first.ranker_log_probability).toBeCloseTo(
      Math.log((first.ranker_probability ?? 0) + 1e-8),
      12,
    );
    expect(first.ranker_entropy).toBeGreaterThan(0);
    expect(first.ranker_entropy).toBeLessThanOrEqual(1);
    expect(first.prototype_bag_count_fraction).toBe(1);
    expect(featureSet?.rows[0]?.values.slice(45)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const pythonBuilderExpected = [
      7, 1.6201851746019649, 0.6321207521957626, -0.4586748236649525, 0, 0, 1,
      1, 0.38427904969940124, 0.9502132223045657, 0.39957652312511366, -2,
      0.11920292202211755, 0.4604948877169001, 0.4904591929846359,
      0.36240304911997295, 0.867806912423605, 0.5, 0.52497918747894,
      0.549833997312478, 0.6899744811276125, 0.6224593312018546,
      0.6681877721681662, 0.7109495026250039, 0.6439142598879724,
      0.23688281808991013, 0.08714431874203257, 0.03205860328008499,
      0.6835034394931654, 0.5, 0.25, 0.25, 0.946394630357186, 1, 0,
      0.7071067811865475, 1, 0, 0.7071067811865475, 0.6767766952966369, 0,
      0.41976004224992175, 0, 0, 1,
    ];
    const actual = featureSet?.rows[0]?.values.slice(0, 45) ?? [];
    expect(actual).toHaveLength(pythonBuilderExpected.length);
    actual.forEach((value, index) => {
      expect(value).toBeCloseTo(pythonBuilderExpected[index] ?? Number.NaN, 11);
    });
  });

  it("fails closed on an unnormalized view gate or candidate-order drift", () => {
    const calibration = requiredCalibration();
    expect(
      buildFontMatchingSelectionFeatureSet(
        { ...rawFeatures(), viewGateWeights: [0.5, 0.2, 0.2] },
        calibration,
      ),
    ).toBeNull();
    expect(
      buildFontMatchingSelectionFeatureSet(
        { ...rawFeatures(), candidateIds: [...CANDIDATE_IDS].reverse() },
        calibration,
      ),
    ).toBeNull();
  });
});

describe("supervised font selection application", () => {
  it("reranks only top3 and reserves confidence for the supervised winner", () => {
    const calibration = calibrationPreferringCandidate(2);
    const featureSet = requiredFeatureSet(calibration);
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: candidates(),
      role: "dialogue",
      calibration,
      featureSet,
      noneAcceptable: false,
    });
    const ranked = result.rankedCandidates;

    expect(result.calibrationApplied).toBe(true);
    expect(result.fallbackReason).toBeNull();
    expect(ranked[0]?.fontId).toBe(CANDIDATE_IDS[2]);
    expect(ranked[0]?.confidence).toBe(
      calibration.operatingPoints.body.risk_lcb,
    );
    expect(ranked[0]?.reasonCodes).toContain(
      "supervised_selection_score_threshold_passed",
    );
    expect(ranked.slice(1).every(({ confidence }) => confidence === 0)).toBe(
      true,
    );
    expect(
      ranked
        .slice(0, 3)
        .map(({ fontId }) => fontId)
        .sort(),
    ).toEqual(CANDIDATE_IDS.slice(0, 3));
  });

  it.each<FontMatchingSemanticRole>(["other", "unknown_needs_review"])(
    "uses the sealed global operating point for %s",
    (role) => {
      const calibration = calibrationWithFlatScores(0.4);
      const result = applySupervisedFontSelectionCalibration({
        rankedCandidates: candidates(),
        role,
        calibration,
        featureSet: requiredFeatureSet(calibration),
        noneAcceptable: false,
      });

      expect(result.calibrationApplied).toBe(true);
      expect(result.rankedCandidates[0]?.confidence).toBe(
        calibration.operatingPoints.global.risk_lcb,
      );
      expect(result.rankedCandidates[0]?.reasonCodes).toContain(
        "supervised_global_operating_point",
      );
    },
  );

  it("preserves ONNX order and exposes fallback when score is below threshold", () => {
    const calibration = calibrationWithFlatScores(0.9);
    const baseCandidates = candidates();
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: baseCandidates,
      role: "other",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
    });

    expect(result.calibrationApplied).toBe(false);
    expect(result.fallbackReason).toBe("score_below_operating_point");
    expect(result.rankedCandidates.map(({ fontId }) => fontId)).toEqual(
      CANDIDATE_IDS,
    );
    expect(result.rankedCandidates.map(({ confidence }) => confidence)).toEqual(
      baseCandidates.map(({ confidence }) => confidence),
    );
    expect(result.rankedCandidates.map(({ totalScore }) => totalScore)).toEqual(
      baseCandidates.map(({ totalScore }) => totalScore),
    );
    expect(result.rankedCandidates[0]?.reasonCodes).toContain(
      "calibration_not_applied",
    );
  });

  it("loads diagnostic evidence but refuses a failed deployment quality point", () => {
    const record = fixtureRecord();
    for (const points of [
      record.operating_points,
      record.oof_report.full_oof,
      record.oof_report.nested_operating_evaluation,
    ]) {
      points.variant.precision_target = 0.99;
      points.variant.precision_target_passed = false;
      points.variant.selection_score_threshold = 0.4;
      points.global.precision_target = 0.99;
      points.global.precision_target_passed = false;
      points.global.selection_score_threshold = 0.4;
    }
    const calibration = requiredParsed(record);
    expect(isFontMatchingSelectionCalibrationDeploymentReady(calibration)).toBe(
      false,
    );
    expect(
      isFontMatchingSelectionCalibrationDeploymentReady(calibration, {
        allowFailedReleaseQuality: true,
      }),
    ).toBe(true);
    const baseCandidates = candidates();
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: baseCandidates,
      role: "sfx_impact",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
    });

    expect(result.calibrationApplied).toBe(false);
    expect(result.fallbackReason).toBe("score_below_operating_point");
    expect(result.rankedCandidates.map(({ fontId }) => fontId)).toEqual(
      baseCandidates.map(({ fontId }) => fontId),
    );
    const qaOnlyResult = applySupervisedFontSelectionCalibration({
      rankedCandidates: baseCandidates,
      role: "sfx_impact",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
      allowFailedReleaseQuality: true,
    });
    expect(qaOnlyResult.calibrationApplied).toBe(true);
  });

  it("does not let the QA-only release override bypass coverage", () => {
    const parsed = requiredParsed(fixtureRecord());
    const calibration = {
      ...parsed,
      operatingPoints: {
        ...parsed.operatingPoints,
        variant: {
          ...parsed.operatingPoints.variant,
          coverage_floor_passed: false,
        },
        global: {
          ...parsed.operatingPoints.global,
          coverage_floor_passed: false,
        },
      },
    };

    expect(
      isFontMatchingSelectionCalibrationDeploymentReady(calibration, {
        allowFailedReleaseQuality: true,
      }),
    ).toBe(false);
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: candidates(),
      role: "sfx_impact",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
      allowFailedReleaseQuality: true,
    });
    expect(result.calibrationApplied).toBe(false);
    expect(result.fallbackReason).toBe("score_below_operating_point");
  });

  it("keeps hard none/invalid signals fail-closed", () => {
    const calibration = requiredCalibration();
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: candidates(),
      role: "sfx_impact",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: true,
    });

    expect(result.calibrationApplied).toBe(false);
    expect(
      result.rankedCandidates.every(({ confidence }) => confidence === 0),
    ).toBe(true);
    expect(result.rankedCandidates[0]?.reasonCodes).toContain(
      "supervised_selection_none_acceptable",
    );
  });

  it("excludes only unrenderable top3 candidates from supervised competition", () => {
    const calibration = calibrationPreferringCandidates(2, 1);
    const input = candidates();
    input[2] = {
      ...(input[2] as RankedFontCandidateV2),
      renderStatus: "unrenderable",
      unrenderableReason: "fixture",
    };
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: input,
      role: "dialogue",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
    });

    expect(result.calibrationApplied).toBe(true);
    expect(result.rankedCandidates[0]?.fontId).toBe(CANDIDATE_IDS[1]);
    expect(
      result.rankedCandidates.find(({ fontId }) => fontId === CANDIDATE_IDS[2])
        ?.reasonCodes,
    ).toContain("supervised_candidate_excluded_unrenderable");
  });

  it("abstains only when no original top3 candidate is renderable", () => {
    const calibration = requiredCalibration();
    const input = candidates().map((candidate, index) =>
      index < 3
        ? {
            ...candidate,
            renderStatus: "unrenderable" as const,
            unrenderableReason: "fixture",
          }
        : candidate,
    );
    const result = applySupervisedFontSelectionCalibration({
      rankedCandidates: input,
      role: "dialogue",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
    });

    expect(result.calibrationApplied).toBe(false);
    expect(result.fallbackReason).toBe("no_renderable_top3");
    expect(
      result.rankedCandidates.every(({ confidence }) => confidence === 0),
    ).toBe(true);
  });

  it("caps a role-family conflict with global artifact evidence, not zero", () => {
    const calibration = calibrationPreferringCandidate(2);
    const selected = applySupervisedFontSelectionCalibration({
      rankedCandidates: candidates(),
      role: "sfx_impact",
      calibration,
      featureSet: requiredFeatureSet(calibration),
      noneAcceptable: false,
    });
    const conflicted = applySelectionRoleFamilyConflictPolicy(
      selected.rankedCandidates,
      "sfx_impact",
      "dialogue",
      calibration,
    );

    expect(conflicted[0]?.confidence).toBeGreaterThan(0);
    expect(conflicted[0]?.confidence).toBeLessThanOrEqual(
      calibration.operatingPoints.global.risk_lcb,
    );
    expect(conflicted[0]?.reasonCodes).toContain(
      "pixel_llm_role_family_conflict_global_cap",
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
    feature_contract: { ...FONT_MATCHING_SELECTION_FEATURE_CONTRACT },
    feature_names: [...FEATURE_NAMES],
    leakage_audit: {
      fit_split: "val",
      non_val_label_rows_parsed: 0,
      pseudo_label_rows_used_for_fit: 0,
      test_rows_used_for_fit: 0,
      test_pixels_opened_for_fit: 0,
      train_rows_used_for_fit: 0,
    } as Record<string, unknown>,
    logistic: {
      c: 1,
      coef: Array.from({ length: FEATURE_NAMES.length }, () => 0),
      intercept: 0,
    },
    oof_report: {
      candidate_log_loss: 0.4,
      candidate_roc_auc: 0.7,
      final_C: 1,
      fit_implementation: {
        max_iter: 3000,
        penalty: "l2",
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
      selected_C_values: [1],
    },
    operating_points: {
      body: { ...point, risk_lcb: 0.87, selection_score_threshold: 0.8 },
      variant: { ...point, risk_lcb: 0.84, selection_score_threshold: 0.82 },
      global: { ...point, risk_lcb: 0.83, selection_score_threshold: 0.75 },
    },
    record_type: FONT_MATCHING_SELECTION_CALIBRATION_RECORD,
    scaler: {
      mean: Array.from({ length: FEATURE_NAMES.length }, () => 0),
      scale: Array.from({ length: FEATURE_NAMES.length }, () => 1),
    },
    schema_version: FONT_MATCHING_SELECTION_CALIBRATION_SCHEMA,
    training_boundary: { calibration_split: "val" } as Record<string, unknown>,
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
    selection_score_threshold: 0.75,
  };
}

function parseFixture(): FontMatchingSelectionCalibration | null {
  return parseRecord(fixtureRecord());
}

function parseRecord(
  record: FixtureRecord,
): FontMatchingSelectionCalibration | null {
  return parseFontMatchingSelectionCalibration(
    JSON.stringify(seal(record)),
    BINDINGS,
  );
}

function requiredCalibration(): FontMatchingSelectionCalibration {
  const parsed = parseFixture();
  if (!parsed) throw new Error("Calibration fixture failed to parse.");
  return parsed;
}

function calibrationPreferringCandidate(
  candidateIndex: number,
): FontMatchingSelectionCalibration {
  const record = fixtureRecord();
  record.logistic.intercept = -5;
  record.logistic.coef[45 + candidateIndex] = 10;
  return requiredParsed(record);
}

function calibrationPreferringCandidates(
  primaryIndex: number,
  secondaryIndex: number,
): FontMatchingSelectionCalibration {
  const record = fixtureRecord();
  record.logistic.intercept = -5;
  record.logistic.coef[45 + primaryIndex] = 10;
  record.logistic.coef[45 + secondaryIndex] = 9;
  return requiredParsed(record);
}

function calibrationWithFlatScores(
  globalThreshold: number,
): FontMatchingSelectionCalibration {
  const record = fixtureRecord();
  record.operating_points.global.selection_score_threshold = globalThreshold;
  return requiredParsed(record);
}

function requiredParsed(
  record: FixtureRecord,
): FontMatchingSelectionCalibration {
  const parsed = parseRecord(record);
  if (!parsed) throw new Error("Calibration fixture failed to parse.");
  return parsed;
}

function rawFeatures() {
  const prototypes = CANDIDATE_IDS.flatMap((_candidate, index) =>
    index % 2 === 0 ? [1, 0] : [0, 1],
  );
  return {
    candidateIds: CANDIDATE_IDS,
    candidateScores: CANDIDATE_IDS.map((_unused, index) => 3 - index),
    runtimeTemperature: 1,
    noneLogit: -2,
    roleLogits: Array.from({ length: 14 }, (_unused, index) =>
      index === 0 ? 2 : 0,
    ),
    styleLogits: Array.from({ length: 10 }, (_unused, index) => index / 10),
    orientationLogits: [2, 1, 0, -1],
    viewGateWeights: [0.5, 0.25, 0.25],
    viewFeatures: [1, 0, 0, 1, 1, 1],
    featureDim: 2,
    prototypeFeatures: prototypes,
    prototypeBags: CANDIDATE_IDS.map((candidateId, index) => ({
      candidateId,
      start: index,
      count: 1,
    })),
  };
}

function requiredFeatureSet(
  calibration: FontMatchingSelectionCalibration,
): FontMatchingSelectionFeatureSet {
  const result = buildFontMatchingSelectionFeatureSet(
    rawFeatures(),
    calibration,
  );
  if (!result) throw new Error("Feature fixture failed to build.");
  return result;
}

function candidates(): RankedFontCandidateV2[] {
  return CANDIDATE_IDS.map((fontId, index) => ({
    rank: index + 1,
    fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: 0.5,
    roleFit: 0.5,
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

function featureMap(values: readonly number[]): Record<string, number> {
  return Object.fromEntries(
    FONT_MATCHING_SELECTION_CONTINUOUS_FEATURES.map((name, index) => [
      name,
      values[index] ?? Number.NaN,
    ]),
  );
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

function pythonStyleCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pythonStyleCanonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${pythonStyleCanonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  if (typeof value === "number" && Number.isInteger(value)) return `${value}.0`;
  return JSON.stringify(value);
}

function pythonRuntimeContractJson(core: Record<string, unknown>): string {
  const placeholder = "0".repeat(64);
  const sorted = sortJsonForTest({ ...core, record_sha256: placeholder });
  const unsealed = `${JSON.stringify(sorted, null, 2)}\n`
    .replace('"temperature": 1', '"temperature": 1.0')
    .replace('"tiny": 0.000001266', '"tiny": 1.266e-06');
  const canonical = canonicalRecordCoreFromJson(unsealed);
  if (!canonical)
    throw new Error("Python runtime fixture failed to canonicalize.");
  const seal = createHash("sha256").update(canonical).digest("hex");
  return unsealed.replace(placeholder, seal);
}

function sortJsonForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonForTest);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJsonForTest(record[key])]),
    );
  }
  return value;
}
