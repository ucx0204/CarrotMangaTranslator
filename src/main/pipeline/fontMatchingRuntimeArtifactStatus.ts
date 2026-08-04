import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FONT_MATCHING_ACTIVE_CATALOG_FILE,
  FONT_MATCHING_RUNTIME_ARTIFACT_RECORD,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
  FONT_MATCHING_RUNTIME_ORT_VERSION,
  FONT_MATCHING_SELECTION_CALIBRATION_FILE,
} from "./fontMatchingRuntimeArtifactContract";
import type {
  AutoMatchActiveCatalog,
  InstalledAutoMatchCandidate,
} from "./autoMatchActiveCatalogTypes";
import { candidateOrderSha256 } from "./autoMatchActiveCatalogContract";
import {
  parseFontMatchingRuntimePolicy,
  type FontMatchingRuntimePolicy,
} from "./fontMatchingRuntimePolicyContract";
import {
  BundleVerificationError,
  readVerifiedRuntimeArtifactBundle,
  type ArtifactDescriptor,
} from "./fontMatchingRuntimeArtifactBundleLoader";
import {
  isFiniteNumber,
  isProbability,
  isSha256,
  recordAt,
  sameCandidateOrder,
  stringArrayAt,
  textAt,
  validHybridRoutingForSchema,
} from "./fontMatchingRuntimeArtifactValidation";

const RUNTIME_ASSET_FILES = [
  FONT_MATCHING_SELECTION_CALIBRATION_FILE,
  "encoder.onnx",
  "ranker.onnx",
  "prototype-features.f32",
] as const;
type RuntimeDisabledReason =
  | "missing_artifact"
  | "artifact_verification_failed"
  | "invalid_contract"
  | "catalog_mismatch"
  | "runtime_version_mismatch";

export type FontMatchingRuntimeArtifactStatus =
  | Readonly<{
      state: "ready";
      automaticMutationAllowed: true;
      semanticBootstrapAllowed: false;
      modelVersion: string;
      catalogVersion: string;
      candidateIds: readonly string[];
      candidateOrderSha256: string;
      calibration: Readonly<{
        temperature: number;
        noneThreshold: number;
      }>;
      policy: FontMatchingRuntimePolicy;
    }>
  | Readonly<{
      state: "disabled";
      automaticMutationAllowed: false;
      semanticBootstrapAllowed: false;
      reason: RuntimeDisabledReason;
    }>;

/** Release verification only; block-bound pixel inference is a separate gate. */
export async function loadFontMatchingRuntimeArtifactStatus({
  artifactDir,
  installedCandidates,
  onnxRuntimeVersion = FONT_MATCHING_RUNTIME_ORT_VERSION,
  allowQaOnlyRuntime = false,
}: {
  artifactDir: string | null | undefined;
  installedCandidates: readonly InstalledAutoMatchCandidate[];
  onnxRuntimeVersion?: string;
  allowQaOnlyRuntime?: boolean;
}): Promise<FontMatchingRuntimeArtifactStatus> {
  if (!artifactDir) return disabled("missing_artifact");
  let bundle;
  try {
    bundle = await readVerifiedRuntimeArtifactBundle(resolve(artifactDir), {
      allowQaOnlyRuntime,
    });
  } catch (error) {
    return disabled(
      error instanceof BundleVerificationError
        ? error.reason
        : "artifact_verification_failed",
    );
  }
  const parsed = parseRuntimeContract(
    bundle.contract,
    bundle.assets,
    bundle.activeCatalog,
  );
  if (!parsed) return disabled("invalid_contract");
  if (parsed.runtimeVersion !== onnxRuntimeVersion) {
    return disabled("runtime_version_mismatch");
  }
  if (
    !(await verifyInstalledCatalog(bundle.activeCatalog, installedCandidates))
  ) {
    return disabled("catalog_mismatch");
  }
  return {
    state: "ready",
    automaticMutationAllowed: true,
    semanticBootstrapAllowed: false,
    modelVersion: parsed.modelVersion,
    catalogVersion: parsed.catalogVersion,
    candidateIds: parsed.candidateIds,
    candidateOrderSha256: parsed.candidateOrderSha256,
    calibration: parsed.calibration,
    policy: parsed.policy,
  };
}

type ParsedRuntimeContract = Readonly<{
  modelVersion: string;
  runtimeVersion: string;
  catalogVersion: string;
  candidateIds: readonly string[];
  candidateOrderSha256: string;
  calibration: Readonly<{
    temperature: number;
    noneThreshold: number;
  }>;
  policy: FontMatchingRuntimePolicy;
}>;

function parseRuntimeContract(
  value: Record<string, unknown>,
  actualAssets: Readonly<Record<string, ArtifactDescriptor>>,
  activeCatalog: AutoMatchActiveCatalog,
): ParsedRuntimeContract | null {
  if (!validContractEnvelope(value)) return null;
  const deployment = recordAt(value, "deployment");
  const fallback = deployment ? recordAt(deployment, "fallback_policy") : null;
  const catalog = parseCatalog(value, activeCatalog);
  const runtime = recordAt(value, "runtime");
  const calibration = recordAt(value, "calibration");
  const parsedCalibration = parseCalibration(calibration);
  const policy = parseFontMatchingRuntimePolicy(recordAt(value, "policy"));
  const modelVersion = textAt(value, "model_version");
  if (
    !validDeployment(deployment, fallback) ||
    !catalog ||
    !validRuntime(runtime) ||
    !parsedCalibration ||
    !policy ||
    !modelVersion
  ) {
    return null;
  }
  if (!validSupportingContractSections(value, actualAssets)) {
    return null;
  }
  return {
    modelVersion,
    runtimeVersion: String(runtime?.version),
    catalogVersion: activeCatalog.catalogVersion,
    candidateIds: activeCatalog.candidateIds,
    candidateOrderSha256: activeCatalog.candidateOrderSha256,
    calibration: parsedCalibration,
    policy,
  };
}

function validSupportingContractSections(
  contract: Record<string, unknown>,
  actualAssets: Readonly<Record<string, ArtifactDescriptor>>,
): boolean {
  return (
    validTestBoundary(recordAt(contract, "test_data_boundary")) &&
    validRuntimeArtifacts(recordAt(contract, "artifacts"), actualAssets) &&
    validHybridRoutingForSchema(contract)
  );
}

function validContractEnvelope(value: Record<string, unknown>): boolean {
  return (
    (value.schema_version === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA ||
      value.schema_version === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2) &&
    value.record_type === FONT_MATCHING_RUNTIME_ARTIFACT_RECORD
  );
}

function parseCatalog(
  contract: Record<string, unknown>,
  activeCatalog: AutoMatchActiveCatalog,
): Record<string, unknown> | null {
  const catalog = recordAt(contract, "catalog");
  const candidateIds = catalog ? stringArrayAt(catalog, "candidate_ids") : null;
  if (
    !catalog ||
    !candidateIds ||
    !validCatalog(catalog, candidateIds, activeCatalog)
  ) {
    return null;
  }
  return catalog;
}

function validCatalog(
  catalog: Record<string, unknown>,
  candidateIds: readonly string[],
  activeCatalog: AutoMatchActiveCatalog,
): boolean {
  return (
    sameCandidateOrder(candidateIds, activeCatalog.candidateIds) &&
    catalog.candidate_count === activeCatalog.candidateIds.length &&
    catalog.candidate_order_sha256 === activeCatalog.candidateOrderSha256 &&
    candidateOrderSha256(candidateIds) === activeCatalog.candidateOrderSha256 &&
    validActiveCatalogBindings(catalog, activeCatalog) &&
    catalog.candidate_parameterization ===
      "prototype-bag-only-no-id-embedding-or-bias" &&
    isSha256(catalog.catalog_registry_sha256) &&
    isSha256(catalog.font_prototypes_sha256)
  );
}

function validActiveCatalogBindings(
  catalog: Record<string, unknown>,
  activeCatalog: AutoMatchActiveCatalog,
): boolean {
  const sources = activeCatalog.sourceRecords;
  return [
    ["catalog_version", activeCatalog.catalogVersion],
    ["active_catalog_record_sha256", activeCatalog.recordSha256],
    [
      "catalog_disposition_record_sha256",
      sources.catalogDispositionRecordSha256,
    ],
    ["final_catalog_record_sha256", sources.finalCatalogRecordSha256],
    ["font_catalog_sha256", sources.deploymentFontFaceManifestSha256],
    ["render_bank_manifest_sha256", sources.deploymentRenderBankManifestSha256],
  ].every(([key, expected]) => catalog[key] === expected);
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

function parseCalibration(
  calibration: Record<string, unknown> | null,
): ParsedRuntimeContract["calibration"] | null {
  if (calibration?.calibration_split !== "val") return null;
  const temperature = calibration.temperature;
  const noneThreshold = calibration.none_threshold;
  if (!isFiniteNumber(temperature) || temperature <= 0 || temperature > 10) {
    return null;
  }
  if (!isProbability(noneThreshold)) return null;
  return { temperature, noneThreshold };
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
  return [FONT_MATCHING_ACTIVE_CATALOG_FILE, ...RUNTIME_ASSET_FILES].every(
    (fileName) => {
      const descriptor = artifacts ? recordAt(artifacts, fileName) : null;
      const actual = actualAssets[fileName];
      return Boolean(
        actual &&
        descriptor?.file === actual.file &&
        descriptor.sha256 === actual.sha256 &&
        descriptor.byte_size === actual.byte_size,
      );
    },
  );
}

async function verifyInstalledCatalog(
  activeCatalog: AutoMatchActiveCatalog,
  installedCandidates: readonly InstalledAutoMatchCandidate[],
): Promise<boolean> {
  if (
    !sameCandidateOrder(
      installedCandidates.map((candidate) => candidate.candidateId),
      activeCatalog.candidateIds,
    )
  ) {
    return false;
  }
  for (let index = 0; index < activeCatalog.candidates.length; index += 1) {
    const expected = activeCatalog.candidates[index];
    const installed = installedCandidates[index];
    if (
      !installed ||
      !sameCandidateOrder(
        installed.assets.map((asset) => asset.faceId),
        expected.assets.map((asset) => asset.faceId),
      ) ||
      installed.assets.length !== expected.assets.length
    ) {
      return false;
    }
    for (
      let assetIndex = 0;
      assetIndex < expected.assets.length;
      assetIndex += 1
    ) {
      const expectedAsset = expected.assets[assetIndex];
      const installedAsset = installed.assets[assetIndex];
      if (
        !installedAsset ||
        installedAsset.file !== expectedAsset.file ||
        installedAsset.byteSize !== expectedAsset.byteSize ||
        installedAsset.sha256 !== expectedAsset.sha256 ||
        !(await verifyInstalledAssetBytes(installedAsset))
      ) {
        return false;
      }
    }
  }
  return true;
}

async function verifyInstalledAssetBytes(
  asset: InstalledAutoMatchCandidate["assets"][number],
): Promise<boolean> {
  try {
    const [stat, bytes] = await Promise.all([
      lstat(asset.resolvedFile),
      readFile(asset.resolvedFile),
    ]);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size === asset.byteSize &&
      bytes.byteLength === asset.byteSize &&
      createHash("sha256").update(bytes).digest("hex") === asset.sha256
    );
  } catch (_error) {
    return false;
  }
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
