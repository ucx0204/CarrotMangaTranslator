import * as path from "node:path";
import type { FluxAssetProgress, NvidiaRedistPackage } from "./types";
import { throwIfAborted } from "./errors";
import { tMain } from "../localization";
import { downloadToFile } from "../../runtimeSupport/modelDownloads";
import { MAX_REMOTE_RUNTIME_ARCHIVE_BYTES } from "../../runtimeSupport/downloadBudgets";
import {
  createLinkedDeadlineController,
  readBoundedResponseText,
} from "../../httpResponseBudget";
import { MAX_RUNTIME_MANIFEST_BYTES } from "../../networkBudgets";
import {
  assertRuntimeFunctions,
  loadAppRuntimeModule,
} from "../../runtimeModuleLoader";

export type ArchiveExtractionLimitOverrides = {
  maximumEntries?: number;
  maximumEntryBytes?: number;
  maximumExpandedBytes?: number;
  maximumCompressionRatio?: number;
};

type RuntimeZipModule = {
  extractSelectedZipEntries: (
    archivePath: string,
    outputDir: string,
    shouldExtract: (fileName: string, relativePath: string) => boolean,
    options?: {
      abortSignal?: AbortSignal;
      deadlineMs?: number;
      limits?: ArchiveExtractionLimitOverrides;
      preserveRelativePaths?: boolean;
      replaceOutputDir?: boolean;
    },
  ) => Promise<void>;
};

let runtimeZipModule: RuntimeZipModule | null = null;

type PinnedNvidiaRuntimeAsset = Readonly<{
  sha256: string;
  size: number;
}>;

const PINNED_NVIDIA_RUNTIME_ASSETS: Readonly<
  Record<string, PinnedNvidiaRuntimeAsset>
> = Object.freeze({
  "libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.0.13-archive.zip":
    Object.freeze({
      sha256:
        "20d9c2cd3810c948b875820917b38053dacf200b23cb3b8b8a14ff3569aa1f31",
      size: 549_211_990,
    }),
  "cuda_cudart/windows-x86_64/cuda_cudart-windows-x86_64-12.9.37-archive.zip":
    Object.freeze({
      sha256:
        "f96afe6df898bc8510c48b44668bd9f825731efbf460f3640a922b2b8ae59ccc",
      size: 3_519_893,
    }),
  "libcurand/windows-x86_64/libcurand-windows-x86_64-10.3.10.19-archive.zip":
    Object.freeze({
      sha256:
        "d0411f0b8c07e90d0fb6e01bfa7a54c9cb80f2ddf67e4ded2d96a50e19aadad6",
      size: 67_904_600,
    }),
  "cudnn/windows-x86_64/cudnn-windows-x86_64-9.21.0.82_cuda12-archive.zip":
    Object.freeze({
      sha256:
        "9c054b33f0e8f074f3b68fd446cdffe2cf875de5f01ed4541fa675e8fdd5ceed",
      size: 676_792_208,
    }),
});

export async function downloadRuntimeArchive(options: {
  downloadsDir: string;
  entry: NvidiaRedistPackage;
  baseUrl: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const url = `${options.baseUrl}/${options.entry.relative_path}`;
  const fileName = path.basename(options.entry.relative_path);
  const outputPath = path.join(options.downloadsDir, fileName);
  if (
    options.entry.size !== undefined &&
    options.entry.size > MAX_REMOTE_RUNTIME_ARCHIVE_BYTES
  ) {
    throw new Error(
      `${fileName} 다운로드 크기가 허용 한도 ${MAX_REMOTE_RUNTIME_ARCHIVE_BYTES} bytes를 초과했습니다.`,
    );
  }
  await downloadToFile({
    url,
    outputPath,
    signal: options.signal,
    progressText: tMain("downloads.downloading", { label: options.label }),
    label: fileName,
    expectedTotalBytes: options.entry.size,
    expectedSha256: options.entry.sha256,
    maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
    onProgress: options.onProgress,
  });
  return outputPath;
}

export async function readJsonUrl(
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  const deadline = createLinkedDeadlineController(
    signal,
    30000,
    "Runtime manifest",
  );
  try {
    const response = await fetch(url, {
      signal: deadline.signal,
      headers: { "User-Agent": "carrot-manga-translator" },
    });
    const rawText = await readBoundedResponseText(response, {
      label: "Runtime manifest",
      maximumBytes: MAX_RUNTIME_MANIFEST_BYTES,
      signal: deadline.signal,
    });
    if (!response.ok) {
      throw new Error(
        tMain("downloads.requestFailed", { url, status: response.status }),
      );
    }
    return JSON.parse(rawText) as unknown;
  } finally {
    deadline.cleanup();
  }
}

export function readNvidiaRedistPackage(
  manifest: unknown,
  packageName: string,
  platform: string,
  variant?: string,
): NvidiaRedistPackage | null {
  const packageRecord = asJsonRecord(asJsonRecord(manifest)[packageName]);
  const platformValue = packageRecord[platform];
  const value = variant ? asJsonRecord(platformValue)[variant] : platformValue;
  const record = asJsonRecord(value);
  const relativePath =
    typeof record.relative_path === "string" ? record.relative_path : "";
  if (!relativePath) {
    return null;
  }
  const manifestSize = readManifestFileSize(record.size);
  const manifestSha256 = readMandatorySha256(record.sha256);
  const pinnedAsset = PINNED_NVIDIA_RUNTIME_ASSETS[relativePath];
  if (!pinnedAsset || manifestSha256 !== pinnedAsset.sha256) {
    throw new Error(
      `NVIDIA runtime archive is not present in the built-in integrity manifest: ${relativePath}`,
    );
  }
  if (manifestSize !== undefined && manifestSize !== pinnedAsset.size) {
    throw new Error(
      `NVIDIA runtime manifest 파일 크기가 내장 무결성 정보와 일치하지 않습니다: ${relativePath}`,
    );
  }
  return {
    relative_path: relativePath,
    sha256: pinnedAsset.sha256,
    size: pinnedAsset.size,
  };
}

function readMandatorySha256(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("NVIDIA runtime manifest에 유효한 SHA-256이 없습니다.");
  }
  return normalized;
}

function readManifestFileSize(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("NVIDIA runtime manifest에 잘못된 파일 크기가 있습니다.");
  }
  return parsed;
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function extractSelectedZipEntries(
  archivePath: string,
  outputDir: string,
  shouldExtract: (fileName: string) => boolean,
  signal?: AbortSignal,
  replaceOutputDir = false,
): Promise<void> {
  await loadRuntimeZipModule().extractSelectedZipEntries(
    archivePath,
    outputDir,
    (fileName) => shouldExtract(fileName),
    { abortSignal: signal, replaceOutputDir },
  );
}

export async function extractZipSafely(
  archivePath: string,
  outputDir: string,
  signal?: AbortSignal,
): Promise<void> {
  await loadRuntimeZipModule().extractSelectedZipEntries(
    archivePath,
    outputDir,
    () => true,
    {
      abortSignal: signal,
      preserveRelativePaths: true,
      replaceOutputDir: true,
    },
  );
}

export async function extractLargeZipSafely(
  archivePath: string,
  outputDir: string,
  signal?: AbortSignal,
  options?: {
    deadlineMs?: number;
    limits?: ArchiveExtractionLimitOverrides;
  },
): Promise<void> {
  await loadRuntimeZipModule().extractSelectedZipEntries(
    archivePath,
    outputDir,
    () => true,
    {
      abortSignal: signal,
      deadlineMs: options?.deadlineMs,
      limits: options?.limits,
      preserveRelativePaths: true,
      replaceOutputDir: true,
    },
  );
}

function loadRuntimeZipModule(): RuntimeZipModule {
  if (runtimeZipModule) {
    return runtimeZipModule;
  }
  const loaded = loadAppRuntimeModule("zipExtractor");
  assertRuntimeFunctions(loaded, "simple-page-zip-utils.cjs", [
    "extractSelectedZipEntries",
  ]);
  runtimeZipModule = loaded as RuntimeZipModule;
  return runtimeZipModule;
}
