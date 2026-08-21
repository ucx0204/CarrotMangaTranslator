import { createHash } from "node:crypto";
import { canonicalNestedRecordCoreFromJson } from "./preservedJsonRecordSeal";

export type FontMatchingReleaseAcceptance = Readonly<{
  accepted: boolean;
  failedCalibrationQualityAccepted: boolean;
}>;

const MANUAL_V2_ACCEPTANCE_SCHEMA =
  "font-matching-runtime-release-acceptance-v2";
const MANUAL_V2_ACCEPTANCE_AUTHORITY =
  "explicit_user_approved_work_disjoint_fresh_gemma_manual_visual_review";
const MANUAL_V2_MODEL_VERSION = "manga-font-v8-active21-dfa42ae17f-ffb3285338";
const MANUAL_V2_RELEASE_SCOPE = `${MANUAL_V2_MODEL_VERSION}/r3h-manual-v2`;
const MANUAL_V2_EVIDENCE = {
  adapter_checkpoint_sha256:
    "ff580ef87c949d9b5cc8f4552490015cb621814d6cd5c122018def415792f3de",
  candidate_order_sha256:
    "17343ec15ee2153e770101d0cbf707600e97a8bc2d490496efaf4da2f638437d",
  cohort_digest:
    "9c1ddde045ab0ddbad1e86fa30c20b869a112a9405eddbe404b0d1292686f5d2",
  manual_review_content_sha256:
    "39e45f037d15dd42f3aa74ee987a0e272d308c13115036f182fc1a6f0dfe1157",
  manual_review_file_sha256:
    "a92a751168d0cbde436371c30e1dcfe613194b80d3eff9787df6b2375f3364eb",
  model_version: MANUAL_V2_MODEL_VERSION,
  ranker_sha256:
    "dfa42ae17f340768cae30f2219973eae1ff62a4c3c1544496502621e6e710c78",
  run_report_sha256:
    "61570016f17039e982c05afb066c92bf649a5ac837d3e8254b847b96bb2d11cb",
  source_evaluation_runtime_contract_sha256:
    "292433b367a7aef5abd8d2b8c3833d521584bc4cb41027924c37774585fdb7f4",
  source_selection_calibration_sha256:
    "501c39cd12019e4334336c486a0b8a87699ea6a5e8845232af5537e0929dc3fb",
  visual_review_index_sha256:
    "5155436a1bf25e2e5694c4cc88d1f65092245e6bc80743484e604ef7984593ad",
} as const;
const R33_ACCEPTANCE_SCHEMA = "font-matching-runtime-release-acceptance-v3";
const R33_ACCEPTANCE_AUTHORITY =
  "explicit_user_approved_cached_page_ab_with_agent_visual_audit";
const R33_ACCEPTANCE_RECORD_SHA256 =
  "80be96c4314db4d89e4bc86ea6221ae2c5eae4b54226b64701e95fd1659c0140";
const R33_MODEL_VERSION = "manga-font-v9-r33-e049fc74c3ba";
const R33_EVIDENCE = {
  candidate_order_sha256:
    "17343ec15ee2153e770101d0cbf707600e97a8bc2d490496efaf4da2f638437d",
  model_version: R33_MODEL_VERSION,
  page_consistency_apply_sha256:
    "eb30c3e7a0a0518b854b83e8ea1c8bb2414d22f1ffd073e551c2d4434b31ace4",
  page_consistency_plan_sha256:
    "099a34473124faeff0d508ae4173c8c7444904c6959558c8bf0b92dc34520352",
  page_consistency_shared_sha256:
    "8aa94b55c963f3b236279e5f67fd9cc8aa6a4ade189bc1bbcf4760eddb427279",
  ranker_sha256:
    "e049fc74c3baeeee9aba179412a3b20387304b749936c167ecc753afcc78f4aa",
  source_evaluation_runtime_contract_sha256:
    "c96f24268af9128d19c2b8a6ff7100c2725e8e991da9d3d6f7320b611e90b972",
  source_marker_sha256:
    "3a794cc2f5ec75eb83f8c060138f50652d2df98ec24bc4beafe34cb1eceaa545",
  source_page_inventory_sha256:
    "2dc2352a401c7a5defa22606ac77a3e99b2a2b72c9f901a7436d4bb471d906d3",
  source_selection_calibration_sha256:
    "aaaaa938d5fbed6070115b2d206c6cc4a35517b3b11061fb0a4d11383caa5660",
  visual_comparison_inventory_sha256:
    "835165dc2048c5a9a3107aa593758c22f14f0ca5940e0c7f40a896c4e4d79b42",
} as const;

/** Undefined means malformed evidence; absence remains a valid unaccepted state. */
export function parseFontMatchingReleaseAcceptance(
  contract: Record<string, unknown>,
  contractJson: string,
): FontMatchingReleaseAcceptance | undefined {
  const raw = contract.release_acceptance;
  if (raw === undefined) {
    return { accepted: false, failedCalibrationQualityAccepted: false };
  }
  if (!isRecord(raw) || !validAcceptanceSeal(raw, contractJson)) {
    return undefined;
  }
  const qualityGate = recordAt(raw, "quality_gate");
  if (!qualityGate || !validCommonEnvelope(raw)) return undefined;
  if (raw.schema_version === "font-matching-runtime-release-acceptance-v1") {
    return raw.automatic_visual_judgment === false &&
      validLegacyV1Gate(qualityGate)
      ? { accepted: true, failedCalibrationQualityAccepted: false }
      : undefined;
  }
  if (raw.schema_version === R33_ACCEPTANCE_SCHEMA) {
    return validR33Acceptance(raw, qualityGate)
      ? { accepted: true, failedCalibrationQualityAccepted: true }
      : undefined;
  }
  return validManualV2Acceptance(raw, qualityGate)
    ? { accepted: true, failedCalibrationQualityAccepted: true }
    : undefined;
}

function validAcceptanceSeal(
  acceptance: Record<string, unknown>,
  contractJson: string,
): boolean {
  const canonicalCore = canonicalNestedRecordCoreFromJson(
    contractJson,
    "release_acceptance",
  );
  return Boolean(
    isSha256(acceptance.record_sha256) &&
    canonicalCore &&
    acceptance.record_sha256 === sha256(canonicalCore),
  );
}

function validCommonEnvelope(acceptance: Record<string, unknown>): boolean {
  return (
    acceptance.record_type === "font_matching_runtime_release_acceptance" &&
    acceptance.status === "accepted" &&
    acceptance.external_release_quality_gate_passed === true &&
    typeof acceptance.automatic_visual_judgment === "boolean"
  );
}

function validLegacyV1Gate(qualityGate: Record<string, unknown>): boolean {
  const manualVerdicts = recordAt(qualityGate, "manual_page_verdicts");
  return Boolean(
    qualityGate.structural_error_count === 0 &&
    manualVerdicts?.accepted === 80 &&
    manualVerdicts.total === 80,
  );
}

function validManualV2Acceptance(
  acceptance: Record<string, unknown>,
  qualityGate: Record<string, unknown>,
): boolean {
  const evidence = recordAt(acceptance, "evidence");
  const publication = recordAt(acceptance, "publication");
  const waiver = recordAt(qualityGate, "calibration_gate_waiver");
  const failures = waiver ? recordAt(waiver, "strict_gate_failures") : null;
  if (!evidence || !publication || !waiver || !failures) return false;
  return (
    validManualV2Envelope(acceptance) &&
    exactRecord(evidence, MANUAL_V2_EVIDENCE) &&
    validPublication(publication) &&
    validWaiver(waiver, failures) &&
    validStrictFailures(failures) &&
    validManualQualityGate(qualityGate, waiver)
  );
}

function validManualV2Envelope(acceptance: Record<string, unknown>): boolean {
  return (
    sameOrder(Object.keys(acceptance).sort(), [
      "acceptance_authority",
      "accepted_at",
      "automatic_visual_judgment",
      "evidence",
      "explicit_user_acceptance",
      "external_release_quality_gate_passed",
      "publication",
      "quality_gate",
      "record_sha256",
      "record_type",
      "schema_version",
      "status",
    ]) &&
    acceptance.schema_version === MANUAL_V2_ACCEPTANCE_SCHEMA &&
    acceptance.acceptance_authority === MANUAL_V2_ACCEPTANCE_AUTHORITY &&
    acceptance.automatic_visual_judgment === false &&
    acceptance.explicit_user_acceptance === true &&
    validUtcTimestamp(acceptance.accepted_at)
  );
}

function validR33Acceptance(
  acceptance: Record<string, unknown>,
  qualityGate: Record<string, unknown>,
): boolean {
  const evidence = recordAt(acceptance, "evidence");
  const publication = recordAt(acceptance, "publication");
  return Boolean(
    evidence &&
    publication &&
    sameOrder(Object.keys(acceptance).sort(), [
      "acceptance_authority",
      "accepted_at",
      "automatic_visual_judgment",
      "evidence",
      "explicit_user_acceptance",
      "external_release_quality_gate_passed",
      "publication",
      "quality_gate",
      "record_sha256",
      "record_type",
      "schema_version",
      "status",
    ]) &&
    acceptance.schema_version === R33_ACCEPTANCE_SCHEMA &&
    acceptance.acceptance_authority === R33_ACCEPTANCE_AUTHORITY &&
    acceptance.record_sha256 === R33_ACCEPTANCE_RECORD_SHA256 &&
    acceptance.automatic_visual_judgment === true &&
    acceptance.explicit_user_acceptance === true &&
    validUtcTimestamp(acceptance.accepted_at) &&
    exactRecord(evidence, R33_EVIDENCE) &&
    validPublication(publication) &&
    exactRecord(qualityGate, {
      cached_development_pages: 5,
      fresh_gemma_or_inpainting_pages: 0,
      gemma_or_inpainting_runs: 0,
      human_gold: false,
      improved_pages: 4,
      independent_holdout: false,
      judged_content_pages: 5,
      live_font_replay_pages: 5,
      outline_loss_count: 0,
      ranker_cpu_batch1_median_multiplier: 1.093,
      ranker_cpu_batch16_median_multiplier: 1.224,
      ranker_cpu_budget_limit_multiplier: 2,
      ranker_cpu_budget_passed: true,
      regressed_pages: 0,
      sfx_body_regression_count: 0,
      structural_error_count: 0,
      unchanged_pages: 1,
      user_visual_verdict: "new_version_better",
    }),
  );
}

function validPublication(publication: Record<string, unknown>): boolean {
  return exactRecord(publication, {
    evaluation_only_annotations_removed: true,
    release_marker_has_no_qa_flags: true,
    source_evaluation_runtime_immutable: true,
    source_model_assets_copied_exactly: true,
  });
}

function validWaiver(
  waiver: Record<string, unknown>,
  failures: Record<string, unknown>,
): boolean {
  return exactRecord(waiver, {
    approved: true,
    exact_scope: MANUAL_V2_RELEASE_SCOPE,
    reason: "explicit_user_acceptance_after_fresh_work_disjoint_manual_review",
    strict_gate_failures: failures,
  });
}

function validStrictFailures(failures: Record<string, unknown>): boolean {
  return exactRecord(failures, {
    global_acceptable_at1: 22 / 31,
    global_precision_target: 0.88,
    global_preferred_at1: 13 / 31,
    variant_acceptable_at1: 22 / 30,
    variant_precision_target: 0.88,
    variant_preferred_at1: 13 / 30,
  });
}

function validManualQualityGate(
  qualityGate: Record<string, unknown>,
  waiver: Record<string, unknown>,
): boolean {
  return exactRecord(qualityGate, {
    acceptable_pages: 15,
    bad_pages: 5,
    calibration_gate_waiver: waiver,
    calibration_release_quality_gate_passed: false,
    distinct_chapters: 40,
    distinct_works: 10,
    fresh_work_disjoint_pages: 40,
    good_pages: 10,
    judged_content_pages: 30,
    master_work_overlap: 0,
    minimum_usable_rate: 0.8,
    outline_loss_count: 0,
    single_day_body_role_count: 0,
    structural_error_count: 0,
    usable_pages: 25,
    usable_rate: 25 / 30,
  });
}

function exactRecord(
  actual: Record<string, unknown>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(expected).sort();
  return (
    sameOrder(Object.keys(actual).sort(), keys) &&
    keys.every((key) => actual[key] === expected[key])
  );
}

function validUtcTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const selected = value[key];
  return isRecord(selected) ? selected : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
