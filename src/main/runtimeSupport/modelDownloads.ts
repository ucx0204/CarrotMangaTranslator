import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { tMain } from "../i18n";
import {
  assertRuntimeFunctions,
  loadRuntimeModuleAtPath,
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
  ) => Promise<void>;
  probeContentLength: (url: string, signal?: AbortSignal) => Promise<number>;
};

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
  progressPhase?: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string> {
  const filePath = path.join(options.modelDir, options.fileName);
  if (
    await isUsableRemoteFile(filePath, options.url, {
      expectedSha256: options.expectedSha256,
      minimumBytes: options.minimumBytes,
    })
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
    onProgress: options.onProgress,
  });
  if (!options.expectedSha256) {
    return filePath;
  }
  const expectedSha256 = options.expectedSha256.toLowerCase();
  const actualSha256 = await sha256File(filePath, options.signal);
  if (actualSha256 !== expectedSha256) {
    await removeInvalidRemoteFile(filePath);
    throw new Error(
      `${options.label} SHA-256 검증에 실패했습니다. expected=${expectedSha256}, actual=${actualSha256}`,
    );
  }
  const fileStat = await stat(filePath);
  await writeRemoteFileMetadata(filePath, {
    url: options.url,
    bytes: fileStat.size,
    downloadedAt: new Date().toISOString(),
    mtimeMs: fileStat.mtimeMs,
    sha256: actualSha256,
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
  expectedTotalBytes?: number;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<void> {
  if (await isUsableRemoteFile(options.outputPath, options.url)) {
    reportDownloadCacheHit(options);
    return;
  }
  const { downloadHfFileWithProgress, probeContentLength } =
    loadDownloadRuntime();
  const expectedTotalBytes = Number(options.expectedTotalBytes);
  const totalBytes =
    Number.isFinite(expectedTotalBytes) && expectedTotalBytes > 0
      ? expectedTotalBytes
      : await probeContentLength(options.url, options.signal);
  let receivedBytes = 0;
  await downloadHfFileWithProgress(
    {
      url: options.url,
      file: path.basename(options.outputPath),
      destination: options.outputPath,
      label: options.label,
      progressPhase: options.progressPhase ?? "inpainting_downloading",
      progressTitle: options.progressText,
      completeTitle: tMain("downloads.completed", { label: options.label }),
    },
    {
      abortSignal: options.signal,
      onProgress: options.onProgress,
    },
    {
      totalBytes,
      onComplete: (bytes) => {
        receivedBytes = bytes;
      },
    },
  );
  await writeRemoteFileMetadata(options.outputPath, {
    url: options.url,
    bytes: receivedBytes,
    downloadedAt: new Date().toISOString(),
  });
}

function loadDownloadRuntime(): DownloadRuntime {
  const runtimePath = resolveDownloadRuntimePath();
  const runtime = loadRuntimeModuleAtPath(runtimePath);
  assertRuntimeFunctions(runtime, runtimePath, [
    "downloadHfFileWithProgress",
    "probeContentLength",
  ]);
  return runtime as DownloadRuntime;
}

function resolveDownloadRuntimePath(): string {
  const fileName = "simple-page-download-utils.cjs";
  const candidates = [
    ...(typeof process.resourcesPath === "string"
      ? [path.join(process.resourcesPath, "app-runtime", fileName)]
      : []),
    path.resolve(__dirname, "..", "..", "app-runtime", fileName),
    path.resolve(__dirname, "..", "runtime", fileName),
    path.resolve(process.cwd(), "src", "main", "runtime", fileName),
  ];
  const runtimePath = candidates.find((candidate) => existsSync(candidate));
  if (!runtimePath) {
    throw new Error(
      `다운로드 런타임 모듈을 찾을 수 없습니다: ${candidates.join(", ")}`,
    );
  }
  return runtimePath;
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
