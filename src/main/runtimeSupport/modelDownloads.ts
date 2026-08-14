import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { tMain } from "../i18n";
import {
  assertRuntimeFunctions,
  loadAppRuntimeModule,
} from "../runtimeModuleLoader";
import { isUsableRemoteFile, writeRemoteFileMetadata } from "./fileProbe";

export type RuntimeAssetProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

type DownloadRuntime = {
  downloadHfFileWithProgress: (
    task: {
      url: string;
      file: string;
      destination: string;
      label: string;
      maximumBytes: number;
      minimumBytes?: number;
      expectedTotalBytes?: number;
      expectedSha256?: string;
      progressPhase?: string;
      progressTitle?: string;
      completeTitle?: string;
    },
    options?: {
      abortSignal?: AbortSignal;
      onProgress?: (progress: RuntimeAssetProgress) => void;
    },
    progress?: {
      totalBytes?: number;
      onComplete?: (receivedBytes: number) => void;
    },
  ) => Promise<unknown>;
  probeContentLength: (
    url: string,
    signal: AbortSignal | undefined,
    maximumBytes: number,
  ) => Promise<number>;
};

type DownloadCompletionReceipt = Readonly<{
  receivedBytes: number;
  verifiedSha256: string | null;
  size: number;
  mtimeMs: number;
}>;

export function hfResolveUrl(
  repo: string,
  fileName: string,
  revision = "main",
): string {
  return `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${encodeURIComponent(fileName)}`;
}

export async function ensureRemoteFile(options: {
  modelDir: string;
  url: string;
  fileName: string;
  label: string;
  expectedSha256?: string;
  minimumBytes?: number;
  maximumBytes: number;
  expectedTotalBytes?: number;
  progressPhase?: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string> {
  assertDownloadOptions(options);
  const filePath = path.join(options.modelDir, options.fileName);
  if (
    (await isFileWithinMaximum(filePath, options.maximumBytes)) &&
    (await isUsableRemoteFile(filePath, options.url, {
      expectedSha256: options.expectedSha256,
      minimumBytes: options.minimumBytes,
    }))
  ) {
    reportVerifiedCacheHit(options);
    return filePath;
  }
  await mkdir(options.modelDir, { recursive: true });
  if (options.expectedSha256) {
    await removeInvalidRemoteFile(filePath);
  }
  await downloadToFile({
    url: options.url,
    outputPath: filePath,
    signal: options.signal,
    progressPhase: options.progressPhase,
    progressText: tMain("downloads.downloading", { label: options.label }),
    label: options.fileName,
    expectedSha256: options.expectedSha256,
    minimumBytes: options.minimumBytes,
    maximumBytes: options.maximumBytes,
    expectedTotalBytes: options.expectedTotalBytes,
    onProgress: options.onProgress,
  });
  return filePath;
}

export async function downloadToFile(options: {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
  progressPhase?: string;
  progressText: string;
  label: string;
  expectedSha256?: string;
  minimumBytes?: number;
  maximumBytes: number;
  expectedTotalBytes?: number;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<void> {
  assertDownloadOptions(options);
  if (
    (await isFileWithinMaximum(options.outputPath, options.maximumBytes)) &&
    (await isUsableRemoteFile(options.outputPath, options.url, {
      expectedSha256: options.expectedSha256,
      minimumBytes: options.minimumBytes,
    }))
  ) {
    reportDownloadCacheHit(options);
    return;
  }
  const { downloadHfFileWithProgress, probeContentLength } =
    loadDownloadRuntime();
  const expectedTotalBytes = Number(options.expectedTotalBytes);
  const totalBytes =
    Number.isFinite(expectedTotalBytes) && expectedTotalBytes > 0
      ? expectedTotalBytes
      : await probeContentLength(
          options.url,
          options.signal,
          options.maximumBytes,
        );
  const receipt = await downloadHfFileWithProgress(
    {
      url: options.url,
      file: path.basename(options.outputPath),
      destination: options.outputPath,
      label: options.label,
      maximumBytes: options.maximumBytes,
      minimumBytes: options.minimumBytes,
      expectedTotalBytes: options.expectedTotalBytes,
      expectedSha256: options.expectedSha256,
      progressPhase: options.progressPhase ?? "inpainting_downloading",
      progressTitle: options.progressText,
      completeTitle: tMain("downloads.completed", { label: options.label }),
    },
    {
      abortSignal: options.signal,
      onProgress: options.onProgress,
    },
    { totalBytes },
  );
  const verified = await verifyDownloadReceipt(options, receipt);
  await writeRemoteFileMetadata(options.outputPath, {
    url: options.url,
    bytes: verified.size,
    downloadedAt: new Date().toISOString(),
    ...(verified.sha256
      ? { mtimeMs: verified.mtimeMs, sha256: verified.sha256 }
      : {}),
  });
}

function loadDownloadRuntime(): DownloadRuntime {
  const runtime = loadAppRuntimeModule("downloadUtils");
  assertRuntimeFunctions(runtime, "downloadUtils", [
    "downloadHfFileWithProgress",
    "probeContentLength",
  ]);
  return runtime as DownloadRuntime;
}

async function verifyDownloadReceipt(
  options: {
    outputPath: string;
    label: string;
    expectedSha256?: string;
    minimumBytes?: number;
    maximumBytes: number;
    expectedTotalBytes?: number;
    signal?: AbortSignal;
  },
  receipt: unknown,
): Promise<{ size: number; mtimeMs: number; sha256?: string }> {
  const fileStat = await stat(options.outputPath);
  if (!isDownloadedSizeValid(options, fileStat)) {
    await removeInvalidRemoteFile(options.outputPath);
    throw new Error(`${options.label} 다운로드 크기 검증에 실패했습니다.`);
  }
  const expectedSha256 = normalizeExpectedSha256(options.expectedSha256);
  if (!expectedSha256) {
    return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  }
  if (isCurrentDownloadReceipt(receipt, fileStat, expectedSha256)) {
    return {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: expectedSha256,
    };
  }
  const actualSha256 = await sha256File(options.outputPath, options.signal);
  if (actualSha256 !== expectedSha256) {
    await removeInvalidRemoteFile(options.outputPath);
    throw new Error(
      `${options.label} SHA-256 검증에 실패했습니다. expected=${expectedSha256}, actual=${actualSha256}`,
    );
  }
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256: actualSha256,
  };
}

function isDownloadedSizeValid(
  options: {
    minimumBytes?: number;
    maximumBytes: number;
    expectedTotalBytes?: number;
  },
  fileStat: Awaited<ReturnType<typeof stat>>,
): boolean {
  return Boolean(
    fileStat.isFile() &&
    fileStat.size <= options.maximumBytes &&
    fileStat.size >= (options.minimumBytes ?? 0) &&
    (options.expectedTotalBytes === undefined ||
      fileStat.size === options.expectedTotalBytes),
  );
}

function isCurrentDownloadReceipt(
  receipt: unknown,
  fileStat: Awaited<ReturnType<typeof stat>>,
  expectedSha256: string,
): boolean {
  return (
    isDownloadCompletionReceipt(receipt) &&
    Object.isFrozen(receipt) &&
    receipt.receivedBytes === fileStat.size &&
    receipt.size === fileStat.size &&
    receipt.mtimeMs === fileStat.mtimeMs &&
    receipt.verifiedSha256 === expectedSha256
  );
}

function isDownloadCompletionReceipt(
  value: unknown,
): value is DownloadCompletionReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Partial<DownloadCompletionReceipt>;
  return Boolean(
    isNonNegativeSafeInteger(receipt.receivedBytes) &&
    isNonNegativeSafeInteger(receipt.size) &&
    Number.isFinite(receipt.mtimeMs) &&
    isReceiptSha256(receipt.verifiedSha256),
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isReceiptSha256(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}

async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function removeInvalidRemoteFile(filePath: string): Promise<void> {
  await Promise.all([
    rm(filePath, { force: true }),
    rm(`${filePath}.mgtmeta.json`, { force: true }),
    rm(`${filePath}.mgt-sha256.json`, { force: true }),
  ]);
}

function reportVerifiedCacheHit(options: {
  label: string;
  fileName: string;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): void {
  options.onProgress?.({
    progressText: tMain("downloads.cached", { label: options.label }),
    detail: options.fileName,
    progressMode: "log-only",
    installLogLine: tMain("downloads.cachedFileLog", {
      label: options.label,
      file: options.fileName,
    }),
  });
}

function reportDownloadCacheHit(options: {
  label: string;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): void {
  options.onProgress?.({
    progressText: tMain("downloads.cached", { label: options.label }),
    detail: options.label,
    progressMode: "log-only",
    installLogLine: tMain("downloads.cachedLog", { label: options.label }),
  });
}

function assertDownloadOptions(options: {
  maximumBytes: number;
  minimumBytes?: number;
  expectedTotalBytes?: number;
  expectedSha256?: string;
}): void {
  const { maximumBytes, minimumBytes, expectedTotalBytes, expectedSha256 } =
    options;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }
  if (expectedTotalBytes === undefined) {
    assertOptionalDownloadFields(maximumBytes, minimumBytes, expectedSha256);
    return;
  }
  if (
    !Number.isSafeInteger(expectedTotalBytes) ||
    expectedTotalBytes < 1 ||
    expectedTotalBytes > maximumBytes
  ) {
    throw new TypeError(
      "expectedTotalBytes must be a positive safe integer within maximumBytes.",
    );
  }
  if (minimumBytes !== undefined && expectedTotalBytes < minimumBytes) {
    throw new TypeError("expectedTotalBytes must not be below minimumBytes.");
  }
  assertOptionalDownloadFields(maximumBytes, minimumBytes, expectedSha256);
}

function assertOptionalDownloadFields(
  maximumBytes: number,
  minimumBytes?: number,
  expectedSha256?: string,
): void {
  if (
    minimumBytes !== undefined &&
    (!Number.isSafeInteger(minimumBytes) ||
      minimumBytes < 1 ||
      minimumBytes > maximumBytes)
  ) {
    throw new TypeError(
      "minimumBytes must be a positive safe integer within maximumBytes.",
    );
  }
  if (
    expectedSha256 !== undefined &&
    !normalizeExpectedSha256(expectedSha256)
  ) {
    throw new TypeError("expectedSha256 must be a 64-character SHA-256 value.");
  }
}

function normalizeExpectedSha256(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

async function isFileWithinMaximum(
  filePath: string,
  maximumBytes: number,
): Promise<boolean> {
  try {
    return (await stat(filePath)).size <= maximumBytes;
  } catch (_error) {
    return true;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
