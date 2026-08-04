import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  FONT_MATCHING_ACTIVE_CATALOG_FILE,
  FONT_MATCHING_RUNTIME_ARTIFACT_OWNER,
  FONT_MATCHING_RUNTIME_ARTIFACT_OWNER_V2,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA,
  FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2,
  FONT_MATCHING_SELECTION_CALIBRATION_FILE,
  type FontMatchingRuntimeArtifactSchema,
} from "./fontMatchingRuntimeArtifactContract";
import { parseAutoMatchActiveCatalog } from "./autoMatchActiveCatalogContract";
import type { AutoMatchActiveCatalog } from "./autoMatchActiveCatalogTypes";
import {
  canonicalNestedRecordCoreFromJson,
  canonicalRecordCoreFromJson,
} from "./preservedJsonRecordSeal";

const MARKER_FILE = ".font-matching-runtime-artifact-owned.json";
const CONTRACT_FILE = "runtime-contract.json";
const RUNTIME_ASSET_FILES = [
  FONT_MATCHING_ACTIVE_CATALOG_FILE,
  FONT_MATCHING_SELECTION_CALIBRATION_FILE,
  "encoder.onnx",
  "ranker.onnx",
  "prototype-features.f32",
] as const;
const CALIBRATED_BUNDLE_FILES = [
  MARKER_FILE,
  CONTRACT_FILE,
  ...RUNTIME_ASSET_FILES,
].sort();
const HYBRID_BASE_BUNDLE_FILES = [
  MARKER_FILE,
  CONTRACT_FILE,
  FONT_MATCHING_ACTIVE_CATALOG_FILE,
  "encoder.onnx",
  "ranker.onnx",
  "prototype-features.f32",
].sort();

export type ArtifactDescriptor = Readonly<{
  file: string;
  sha256: string;
  byte_size: number;
}>;

export type VerifiedRuntimeArtifactBundle = Readonly<{
  contract: Record<string, unknown>;
  /** Exact verified text, retained for Python-compatible source reconstruction. */
  contractJson: string;
  assets: Readonly<Record<string, ArtifactDescriptor>>;
  /**
   * Bytes that were hashed in the same verification pass as `assets`.
   * Consumers must create ONNX sessions from these detached bytes instead of
   * reopening the paths, which closes the bundle verification/use race.
   */
  assetBytes: Readonly<Record<string, Uint8Array>>;
  activeCatalog: AutoMatchActiveCatalog;
  schemaVersion: FontMatchingRuntimeArtifactSchema;
  qaOnly: boolean;
  releaseAccepted: boolean;
}>;

export class BundleVerificationError extends Error {
  constructor(
    readonly reason: "missing_artifact" | "artifact_verification_failed",
  ) {
    super(reason);
  }
}

export async function readVerifiedRuntimeArtifactBundle(
  root: string,
  options: Readonly<{ allowQaOnlyRuntime?: boolean }> = {},
): Promise<VerifiedRuntimeArtifactBundle> {
  await assertRootDirectory(root);
  const marker = await readVerifiedMarker(
    root,
    Boolean(options.allowQaOnlyRuntime),
  );
  await assertExactInventory(root, marker.schemaVersion, marker.hasCalibration);
  const { assets, assetBytes, contractBytes } = await readVerifiedFiles(
    root,
    marker.artifacts,
    marker.hasCalibration,
  );
  const contractJson = decodeUtf8(contractBytes);
  const contract = parseJsonRecord(contractJson);
  if (!validRecordSeal(contract, contractJson)) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  if (contract.schema_version !== marker.schemaVersion) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  const releaseAccepted = parseReleaseAcceptance(contract, contractJson);
  const activeCatalog = parseAutoMatchActiveCatalog(
    await readJsonRecord(join(root, FONT_MATCHING_ACTIVE_CATALOG_FILE)),
  );
  if (!activeCatalog) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return {
    contract,
    contractJson,
    assets,
    assetBytes,
    activeCatalog,
    schemaVersion: marker.schemaVersion,
    qaOnly: marker.qaOnly,
    releaseAccepted,
  };
}

function parseReleaseAcceptance(
  contract: Record<string, unknown>,
  contractJson: string,
): boolean {
  const raw = contract.release_acceptance;
  if (raw === undefined) return false;
  if (!isRecord(raw)) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  const acceptance = raw;
  const qualityGate = recordAt(acceptance, "quality_gate");
  if (!qualityGate) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  const manualVerdicts = recordAt(qualityGate, "manual_page_verdicts");
  const canonicalCore = canonicalNestedRecordCoreFromJson(
    contractJson,
    "release_acceptance",
  );
  if (!manualVerdicts || !canonicalCore) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  const accepted = [
    acceptance.schema_version === "font-matching-runtime-release-acceptance-v1",
    acceptance.record_type === "font_matching_runtime_release_acceptance",
    isSha256(acceptance.record_sha256),
    acceptance.record_sha256 === sha256(canonicalCore),
    acceptance.status === "accepted",
    acceptance.external_release_quality_gate_passed === true,
    acceptance.automatic_visual_judgment === false,
    qualityGate.structural_error_count === 0,
    manualVerdicts.accepted === 80,
    manualVerdicts.total === 80,
  ].every(Boolean);
  if (!accepted) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return true;
}

async function assertRootDirectory(root: string): Promise<void> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new BundleVerificationError("artifact_verification_failed");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BundleVerificationError("missing_artifact");
    }
    throw error;
  }
}

async function assertExactInventory(
  root: string,
  schemaVersion: FontMatchingRuntimeArtifactSchema,
  hasCalibration: boolean,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  const expected =
    schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2 &&
    !hasCalibration
      ? HYBRID_BASE_BUNDLE_FILES
      : CALIBRATED_BUNDLE_FILES;
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    !sameOrder(names, expected)
  ) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
}

async function readVerifiedMarker(
  root: string,
  allowQaOnlyRuntime: boolean,
): Promise<{
  artifacts: Record<string, unknown>;
  hasCalibration: boolean;
  schemaVersion: FontMatchingRuntimeArtifactSchema;
  qaOnly: boolean;
}> {
  const marker = await readJsonRecord(join(root, MARKER_FILE));
  const qaOnly = parseQaOnlyMarker(marker, allowQaOnlyRuntime);
  const schemaVersion = parseSupportedSchema(marker.schema_version);
  const owner =
    schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2
      ? FONT_MATCHING_RUNTIME_ARTIFACT_OWNER_V2
      : FONT_MATCHING_RUNTIME_ARTIFACT_OWNER;
  if (
    !schemaVersion ||
    marker.owner !== owner ||
    marker.safe_replace !== true
  ) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  const markerArtifacts = recordAt(marker, "artifacts");
  const markerFiles = markerArtifacts
    ? Object.keys(markerArtifacts).sort()
    : [];
  const calibratedFiles = [CONTRACT_FILE, ...RUNTIME_ASSET_FILES].sort();
  const hybridBaseFiles = [
    CONTRACT_FILE,
    FONT_MATCHING_ACTIVE_CATALOG_FILE,
    "encoder.onnx",
    "ranker.onnx",
    "prototype-features.f32",
  ].sort();
  const hasCalibration = sameOrder(markerFiles, calibratedFiles);
  const validHybridBase =
    schemaVersion === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2 &&
    sameOrder(markerFiles, hybridBaseFiles);
  if (!markerArtifacts || (!hasCalibration && !validHybridBase)) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return {
    artifacts: markerArtifacts,
    hasCalibration,
    schemaVersion,
    qaOnly,
  };
}

function parseQaOnlyMarker(
  marker: Record<string, unknown>,
  allowQaOnlyRuntime: boolean,
): boolean {
  const hasQaOnly = Object.hasOwn(marker, "qa_only");
  const hasReleaseApproved = Object.hasOwn(marker, "release_approved");
  if (!hasQaOnly && !hasReleaseApproved) return false;
  if (
    !allowQaOnlyRuntime ||
    !hasQaOnly ||
    !hasReleaseApproved ||
    marker.qa_only !== true ||
    marker.release_approved !== false
  ) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return true;
}

async function readVerifiedFiles(
  root: string,
  markerArtifacts: Record<string, unknown>,
  hasCalibration: boolean,
): Promise<{
  assets: Record<string, ArtifactDescriptor>;
  assetBytes: Record<string, Uint8Array>;
  contractBytes: Uint8Array;
}> {
  const files = [
    CONTRACT_FILE,
    FONT_MATCHING_ACTIVE_CATALOG_FILE,
    ...(hasCalibration ? [FONT_MATCHING_SELECTION_CALIBRATION_FILE] : []),
    "encoder.onnx",
    "ranker.onnx",
    "prototype-features.f32",
  ];
  const assets: Record<string, ArtifactDescriptor> = {};
  const assetBytes: Record<string, Uint8Array> = {};
  let contractBytes: Uint8Array | null = null;
  for (const fileName of files) {
    const path = join(root, fileName);
    const bytes = await readFile(path);
    const stat = await lstat(path);
    const digest = sha256(bytes);
    if (
      markerArtifacts[fileName] !== digest ||
      !stat.isFile() ||
      stat.isSymbolicLink()
    ) {
      throw new BundleVerificationError("artifact_verification_failed");
    }
    if (fileName === CONTRACT_FILE) {
      contractBytes = Uint8Array.from(bytes);
    } else {
      assets[fileName] = {
        file: fileName,
        sha256: digest,
        byte_size: stat.size,
      };
      assetBytes[fileName] = Uint8Array.from(bytes);
    }
  }
  if (!contractBytes) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return { assets, assetBytes, contractBytes };
}

function parseSupportedSchema(
  value: unknown,
): FontMatchingRuntimeArtifactSchema | null {
  return value === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA ||
    value === FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA_V2
    ? value
    : null;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    return parseJsonRecord(await readFile(path, "utf8"));
  } catch (error) {
    throw new BundleVerificationError(
      error instanceof BundleVerificationError
        ? error.reason
        : "artifact_verification_failed",
    );
  }
}

function parseJsonRecord(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
    throw new BundleVerificationError("artifact_verification_failed");
  } catch (error) {
    if (error instanceof BundleVerificationError) throw error;
    throw new BundleVerificationError("artifact_verification_failed");
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_error) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
}

function validRecordSeal(
  record: Record<string, unknown>,
  rawJson: string,
): boolean {
  if (!isSha256(record.record_sha256)) return false;
  const canonicalCore = canonicalRecordCoreFromJson(rawJson);
  return (
    canonicalCore !== null && record.record_sha256 === sha256(canonicalCore)
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
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

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
