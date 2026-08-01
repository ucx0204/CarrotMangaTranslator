import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA } from "./fontMatchingRuntimeArtifactContract";

const OWNER = "carrot-manga-translator/font-matching-runtime-artifact";
const MARKER_FILE = ".font-matching-runtime-artifact-owned.json";
const CONTRACT_FILE = "runtime-contract.json";
const RUNTIME_ASSET_FILES = [
  "encoder.onnx",
  "ranker.onnx",
  "prototype-features.f32",
] as const;
const BUNDLE_FILES = [
  MARKER_FILE,
  CONTRACT_FILE,
  ...RUNTIME_ASSET_FILES,
].sort();

export type ArtifactDescriptor = Readonly<{
  file: string;
  sha256: string;
  byte_size: number;
}>;

type VerifiedBundle = Readonly<{
  contract: Record<string, unknown>;
  assets: Readonly<Record<string, ArtifactDescriptor>>;
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
): Promise<VerifiedBundle> {
  await assertRootDirectory(root);
  await assertExactInventory(root);
  const markerArtifacts = await readVerifiedMarker(root);
  const assets = await readVerifiedFiles(root, markerArtifacts);
  const contract = await readJsonRecord(join(root, CONTRACT_FILE));
  if (!validRecordSeal(contract)) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return { contract, assets };
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

async function assertExactInventory(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    !sameOrder(names, BUNDLE_FILES)
  ) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
}

async function readVerifiedMarker(
  root: string,
): Promise<Record<string, unknown>> {
  const marker = await readJsonRecord(join(root, MARKER_FILE));
  if (
    marker.owner !== OWNER ||
    marker.schema_version !== FONT_MATCHING_RUNTIME_ARTIFACT_SCHEMA ||
    marker.safe_replace !== true
  ) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  const markerArtifacts = recordAt(marker, "artifacts");
  const expectedFiles = [CONTRACT_FILE, ...RUNTIME_ASSET_FILES].sort();
  if (
    !markerArtifacts ||
    !sameOrder(Object.keys(markerArtifacts).sort(), expectedFiles)
  ) {
    throw new BundleVerificationError("artifact_verification_failed");
  }
  return markerArtifacts;
}

async function readVerifiedFiles(
  root: string,
  markerArtifacts: Record<string, unknown>,
): Promise<Record<string, ArtifactDescriptor>> {
  const files = [CONTRACT_FILE, ...RUNTIME_ASSET_FILES];
  const assets: Record<string, ArtifactDescriptor> = {};
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
    if (fileName !== CONTRACT_FILE) {
      assets[fileName] = {
        file: fileName,
        sha256: digest,
        byte_size: stat.size,
      };
    }
  }
  return assets;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed)) return parsed;
    throw new BundleVerificationError("artifact_verification_failed");
  } catch (error) {
    throw new BundleVerificationError(
      error instanceof BundleVerificationError
        ? error.reason
        : "artifact_verification_failed",
    );
  }
}

function validRecordSeal(record: Record<string, unknown>): boolean {
  if (!isSha256(record.record_sha256)) return false;
  const core = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "record_sha256"),
  );
  return record.record_sha256 === sha256(canonicalJson(core));
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
