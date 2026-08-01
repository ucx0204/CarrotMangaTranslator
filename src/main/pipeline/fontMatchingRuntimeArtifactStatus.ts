import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  FONT_MATCHING_RUNTIME_ARTIFACT_RECORD,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
  FONT_MATCHING_RUNTIME_CANDIDATE_ORDER_SHA256,
  FONT_MATCHING_RUNTIME_ORT_VERSION,
} from "./fontMatchingRuntimeArtifactContract";
import {
  BundleVerificationError,
  readVerifiedRuntimeArtifactBundle,
  type ArtifactDescriptor,
} from "./fontMatchingRuntimeArtifactBundleLoader";

const RUNTIME_ASSET_FILES = [
  "encoder.onnx",
  "ranker.onnx",
  "prototype-features.f32",
] as const;

type RuntimeDisabledReason =
  | "missing_artifact"
  | "artifact_verification_failed"
  | "invalid_contract"
  | "catalog_mismatch"
  | "runtime_version_mismatch"
  | "runtime_inference_unavailable";

export type FontMatchingRuntimeArtifactStatus =
  | Readonly<{
      state: "ready";
      automaticMutationAllowed: true;
      semanticBootstrapAllowed: false;
      modelVersion: string;
      candidateIds: readonly string[];
      candidateOrderSha256: string;
      calibration: Readonly<{
        temperature: number;
        noneThreshold: number;
      }>;
    }>
  | Readonly<{
      state: "disabled";
      automaticMutationAllowed: false;
      semanticBootstrapAllowed: false;
      reason: RuntimeDisabledReason;
    }>;

/**
 * Main-process-only bundle verification boundary.
 *
 * A structurally valid bundle remains disabled until a future Electron runtime
 * verifies the real ONNX graphs and produces block-bound pixel inference.
 */
export async function loadFontMatchingRuntimeArtifactStatus({
  artifactDir,
  installedCandidateIds,
  onnxRuntimeVersion = FONT_MATCHING_RUNTIME_ORT_VERSION,
}: {
  artifactDir: string | null | undefined;
  installedCandidateIds: readonly string[];
  onnxRuntimeVersion?: string;
}): Promise<FontMatchingRuntimeArtifactStatus> {
  if (!artifactDir) return disabled("missing_artifact");
  let bundle;
  try {
    bundle = await readVerifiedRuntimeArtifactBundle(resolve(artifactDir));
  } catch (error) {
    return disabled(
      error instanceof BundleVerificationError
        ? error.reason
        : "artifact_verification_failed",
    );
  }
  const parsed = parseRuntimeContract(bundle.contract, bundle.assets);
  if (!parsed) return disabled("invalid_contract");
  if (parsed.runtimeVersion !== onnxRuntimeVersion) {
    return disabled("runtime_version_mismatch");
  }
  if (
    !sameCandidateOrder(
      installedCandidateIds,
      FONT_MATCHING_RUNTIME_CANDIDATE_IDS,
    )
  ) {
    return disabled("catalog_mismatch");
  }
  // No Electron ONNX/WASM session or block-local pixel inference is wired yet.
  // A verified package must therefore remain fail-closed.
  return disabled("runtime_inference_unavailable");
}

type ParsedRuntimeContract = Readonly<{
  modelVersion: string;
  runtimeVersion: string;
}>;

function parseRuntimeContract(
  value: Record<string, unknown>,
  actualAssets: Readonly<Record<string, ArtifactDescriptor>>,
): ParsedRuntimeContract | null {
  if (!validContractEnvelope(value)) return null;
  const deployment = recordAt(value, "deployment");
  const fallback = deployment ? recordAt(deployment, "fallback_policy") : null;
  const catalog = parseCatalog(value);
  const runtime = recordAt(value, "runtime");
  const calibration = recordAt(value, "calibration");
  const policy = recordAt(value, "policy");
  const chapterPrior = policy ? recordAt(policy, "chapter_prior") : null;
  const modelVersion = textAt(value, "model_version");
  if (
    !validDeployment(deployment, fallback) ||
    !catalog ||
    !validRuntime(runtime) ||
    !modelVersion
  ) {
    return null;
  }
  if (
    !validSupportingContractSections(
      value,
      calibration,
      chapterPrior,
      actualAssets,
    )
  ) {
    return null;
  }
  return { modelVersion, runtimeVersion: String(runtime?.version) };
}

function validSupportingContractSections(
  contract: Record<string, unknown>,
  calibration: Record<string, unknown> | null,
  chapterPrior: Record<string, unknown> | null,
  actualAssets: Readonly<Record<string, ArtifactDescriptor>>,
): boolean {
  return (
    validCalibration(calibration) &&
    validChapterPrior(chapterPrior) &&
    validTestBoundary(recordAt(contract, "test_data_boundary")) &&
    validRuntimeArtifacts(recordAt(contract, "artifacts"), actualAssets)
  );
}

function validContractEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.schema_version === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA &&
    value.record_type === FONT_MATCHING_RUNTIME_ARTIFACT_RECORD
  );
}

function parseCatalog(
  contract: Record<string, unknown>,
): Record<string, unknown> | null {
  const catalog = recordAt(contract, "catalog");
  const candidateIds = catalog ? stringArrayAt(catalog, "candidate_ids") : null;
  if (!catalog || !candidateIds || !validCatalog(catalog, candidateIds)) {
    return null;
  }
  return catalog;
}

function validCatalog(
  catalog: Record<string, unknown>,
  candidateIds: readonly string[],
): boolean {
  return (
    sameCandidateOrder(candidateIds, FONT_MATCHING_RUNTIME_CANDIDATE_IDS) &&
    catalog.candidate_count === FONT_MATCHING_RUNTIME_CANDIDATE_IDS.length &&
    catalog.candidate_order_sha256 ===
      FONT_MATCHING_RUNTIME_CANDIDATE_ORDER_SHA256 &&
    candidateOrderSha256(candidateIds) ===
      FONT_MATCHING_RUNTIME_CANDIDATE_ORDER_SHA256 &&
    catalog.candidate_parameterization ===
      "prototype-bag-only-no-id-embedding-or-bias" &&
    isSha256(catalog.catalog_registry_sha256) &&
    isSha256(catalog.font_catalog_sha256) &&
    isSha256(catalog.font_prototypes_sha256) &&
    isSha256(catalog.render_bank_manifest_sha256)
  );
}

function validDeployment(
  deployment: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null,
): boolean {
  return Boolean(
    deployment?.state === "ready" &&
    deployment.automatic_mutation_allowed === true &&
    deployment.fail_closed === true &&
    fallback?.missing_artifact === "explicit_disabled" &&
    fallback.invalid_artifact === "explicit_disabled" &&
    fallback.semantic_bootstrap === "forbidden" &&
    fallback.automatic_profile_without_pixel_model === "forbidden" &&
    fallback.manual_user_lock === "allowed",
  );
}

function validRuntime(runtime: Record<string, unknown> | null): boolean {
  return Boolean(
    runtime?.package === "onnxruntime-web" &&
    runtime.execution_provider === "wasm" &&
    typeof runtime.version === "string" &&
    runtime.version.length > 0,
  );
}

function validCalibration(
  calibration: Record<string, unknown> | null,
): boolean {
  return Boolean(
    calibration?.calibration_split === "val" &&
    isFiniteNumber(calibration.temperature) &&
    calibration.temperature > 0 &&
    calibration.temperature <= 10 &&
    isProbability(calibration.none_threshold),
  );
}

function validChapterPrior(prior: Record<string, unknown> | null): boolean {
  return Boolean(
    prior?.mode === "weak_prior_never_hard_constraint" &&
    prior.scope === "chapter" &&
    prior.real_local_change_overrides_prior === true &&
    isProbability(prior.maximum_score_contribution) &&
    prior.maximum_score_contribution <= 0.1 &&
    Number.isInteger(prior.minimum_anchor_evidence_count) &&
    Number(prior.minimum_anchor_evidence_count) >= 2 &&
    isProbability(prior.local_override_minimum_score_margin),
  );
}

function validTestBoundary(boundary: Record<string, unknown> | null): boolean {
  return Boolean(
    boundary?.aggregate_metrics_only === true &&
    boundary.frozen_test_pixels_opened_by_exporter === 0 &&
    boundary.row_level_predictions_packaged === false &&
    boundary.sample_identifiers_packaged === false &&
    boundary.training_or_validation_pixels_packaged === false,
  );
}

function validRuntimeArtifacts(
  artifacts: Record<string, unknown> | null,
  actualAssets: Readonly<Record<string, ArtifactDescriptor>>,
): boolean {
  return RUNTIME_ASSET_FILES.every((fileName) => {
    const descriptor = artifacts ? recordAt(artifacts, fileName) : null;
    const actual = actualAssets[fileName];
    return Boolean(
      actual &&
      descriptor?.file === actual.file &&
      descriptor.sha256 === actual.sha256 &&
      descriptor.byte_size === actual.byte_size,
    );
  });
}

function candidateOrderSha256(candidateIds: readonly string[]): string {
  return createHash("sha256")
    .update(`${candidateIds.join("\n")}\n`, "utf8")
    .digest("hex");
}

function disabled(
  reason: RuntimeDisabledReason,
): FontMatchingRuntimeArtifactStatus {
  return {
    state: "disabled",
    automaticMutationAllowed: false,
    semanticBootstrapAllowed: false,
    reason,
  };
}

function sameCandidateOrder(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const selected = value[key];
  return isRecord(selected) ? selected : null;
}

function stringArrayAt(
  value: Record<string, unknown>,
  key: string,
): readonly string[] | null {
  const selected = value[key];
  return Array.isArray(selected) &&
    selected.every((entry) => typeof entry === "string")
    ? selected
    : null;
}

function textAt(value: Record<string, unknown>, key: string): string | null {
  const selected = value[key];
  return typeof selected === "string" && selected.trim().length > 0
    ? selected
    : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}
