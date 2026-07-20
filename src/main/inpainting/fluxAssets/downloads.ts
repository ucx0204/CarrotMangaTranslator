import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import type { FluxAssetProgress, NvidiaRedistPackage } from "./types";
import { throwIfAborted, runCommand } from "./errors";
import { tMain } from "../localization";
import {
  isPathInside,
  isUsableRemoteFile,
  writeRemoteFileMetadata,
} from "./fileProbe";

const AdmZip = require("adm-zip");
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
      onProgress?: (progress: FluxAssetProgress) => void;
    },
    progress?: {
      totalBytes?: number;
      onComplete?: (receivedBytes: number) => void;
    },
  ) => Promise<void>;
  probeContentLength: (url: string, signal?: AbortSignal) => Promise<number>;
};

let cachedDownloadRuntime: DownloadRuntime | null = null;

function loadDownloadRuntime(): DownloadRuntime {
  if (cachedDownloadRuntime) return cachedDownloadRuntime;
  const runtimePath = resolveDownloadRuntimePath();
  const runtime = require(runtimePath) as Partial<DownloadRuntime>;
  if (
    typeof runtime.downloadHfFileWithProgress !== "function" ||
    typeof runtime.probeContentLength !== "function"
  ) {
    throw new Error(`다운로드 런타임 모듈이 올바르지 않습니다: ${runtimePath}`);
  }
  cachedDownloadRuntime = runtime as DownloadRuntime;
  return cachedDownloadRuntime;
}

function resolveDownloadRuntimePath(): string {
  const fileName = "simple-page-download-utils.cjs";
  const candidates = [
    ...(typeof process.resourcesPath === "string"
      ? [path.join(process.resourcesPath, "app-runtime", fileName)]
      : []),
    path.resolve(__dirname, "..", "..", "..", "app-runtime", fileName),
    path.resolve(__dirname, "..", "..", "runtime", fileName),
  ];
  const runtimePath = candidates.find((candidate) => existsSync(candidate));
  if (!runtimePath) {
    throw new Error(
      `다운로드 런타임 모듈을 찾을 수 없습니다: ${candidates.join(", ")}`,
    );
  }
  return runtimePath;
}

export async function downloadRuntimeArchive(options: {
  downloadsDir: string;
  entry: { relative_path: string; size?: number };
  baseUrl: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const url = `${options.baseUrl}/${options.entry.relative_path}`;
  const fileName = path.basename(options.entry.relative_path);
  const outputPath = path.join(options.downloadsDir, fileName);
  await downloadToFile({
    url,
    outputPath,
    signal: options.signal,
    progressText: tMain("downloads.downloading", { label: options.label }),
    label: fileName,
    expectedTotalBytes: options.entry.size,
    onProgress: options.onProgress,
  });
  return outputPath;
}

export async function readJsonUrl(
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  const response = await fetch(url, {
    signal,
    headers: { "User-Agent": "carrot-manga-translator" },
  });
  if (!response.ok) {
    throw new Error(
      tMain("downloads.requestFailed", { url, status: response.status }),
    );
  }
  return response.json();
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
  const rawSize = record.size;
  const size = Number.isFinite(rawSize) ? (rawSize as number) : undefined;
  return {
    relative_path: relativePath,
    ...(size === undefined ? {} : { size }),
  };
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function extractSelectedZipEntries(
  archivePath: string,
  outputDir: string,
  shouldExtract: (fileName: string) => boolean,
): void {
  const zip = new AdmZip(archivePath);
  let extracted = 0;
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const fileName = path.basename(item.entryName);
    if (!fileName || !shouldExtract(fileName)) {
      continue;
    }
    zip.extractEntryTo(item, outputDir, false, true, false, fileName);
    extracted += 1;
  }
  if (extracted === 0) {
    throw new Error(
      tMain("downloads.runtimeDllMissing", {
        archive: path.basename(archivePath),
      }),
    );
  }
}

export function extractZipSafely(archivePath: string, outputDir: string): void {
  const zip = new AdmZip(archivePath);
  const root = path.resolve(outputDir);
  for (const item of zip.getEntries()) {
    if (item.isDirectory) {
      continue;
    }
    const name = path.normalize(item.entryName).replace(/^([/\\])+/, "");
    if (!name || name.startsWith("..") || path.isAbsolute(name)) {
      throw new Error(
        tMain("downloads.unsafeArchivePath", {
          archive: path.basename(archivePath),
          path: item.entryName,
        }),
      );
    }
    const destination = path.resolve(root, name);
    if (!isPathInside(destination, root)) {
      throw new Error(
        tMain("downloads.unsafeArchivePath", {
          archive: path.basename(archivePath),
          path: item.entryName,
        }),
      );
    }
    zip.extractEntryTo(item, root, true, true);
  }
}

export async function extractLargeZipSafely(
  archivePath: string,
  outputDir: string,
): Promise<void> {
  const root = path.resolve(outputDir);
  await mkdir(root, { recursive: true });
  const entries: string[] = [];
  await runCommand("tar.exe", ["-tf", archivePath], {
    cwd: root,
    onLine(line) {
      const trimmed = line.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    },
  });
  validateArchiveEntries(entries, archivePath, root);
  await runCommand("tar.exe", ["-xf", archivePath, "-C", root], { cwd: root });
}

function validateArchiveEntries(
  entries: string[],
  archivePath: string,
  outputRoot: string,
): void {
  if (entries.length === 0) {
    throw new Error(
      tMain("downloads.archiveEmpty", { archive: path.basename(archivePath) }),
    );
  }
  for (const rawEntry of entries) {
    const entryName = path
      .normalize(rawEntry)
      .replace(/^([/\\])+/, "")
      .replace(/^\.([/\\])+/, "");
    if (!entryName || entryName === ".") {
      continue;
    }
    if (entryName.startsWith("..") || path.isAbsolute(entryName)) {
      throw new Error(
        tMain("downloads.unsafeArchivePath", {
          archive: path.basename(archivePath),
          path: rawEntry,
        }),
      );
    }
    const destination = path.resolve(outputRoot, entryName);
    if (!isPathInside(destination, outputRoot)) {
      throw new Error(
        tMain("downloads.unsafeArchivePath", {
          archive: path.basename(archivePath),
          path: rawEntry,
        }),
      );
    }
  }
}

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
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const filePath = path.join(options.modelDir, options.fileName);
  if (
    await isUsableRemoteFile(filePath, options.url, {
      expectedSha256: options.expectedSha256,
      minimumBytes: options.minimumBytes,
    })
  ) {
    options.onProgress?.({
      progressText: tMain("downloads.cached", { label: options.label }),
      detail: options.fileName,
      progressMode: "log-only",
      installLogLine: tMain("downloads.cachedFileLog", {
        label: options.label,
        file: options.fileName,
      }),
    });
    return filePath;
  }
  await mkdir(options.modelDir, { recursive: true });
  if (options.expectedSha256) {
    await Promise.all([
      rm(filePath, { force: true }),
      rm(`${filePath}.mgtmeta.json`, { force: true }),
    ]);
  }
  await downloadToFile({
    url: options.url,
    outputPath: filePath,
    signal: options.signal,
    progressText: tMain("downloads.downloading", { label: options.label }),
    label: options.fileName,
    onProgress: options.onProgress,
  });
  if (options.expectedSha256) {
    const actualSha256 = await sha256File(filePath, options.signal);
    if (actualSha256 !== options.expectedSha256.toLowerCase()) {
      await Promise.all([
        rm(filePath, { force: true }),
        rm(`${filePath}.mgtmeta.json`, { force: true }),
      ]);
      throw new Error(
        `${options.label} SHA-256 검증에 실패했습니다. expected=${options.expectedSha256.toLowerCase()}, actual=${actualSha256}`,
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
  }
  return filePath;
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

type DownloadToFileOptions = {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
  progressText: string;
  label: string;
  expectedTotalBytes?: number;
  onProgress?: (progress: FluxAssetProgress) => void;
};

export async function downloadToFile(
  options: DownloadToFileOptions,
): Promise<void> {
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
      progressPhase: "inpainting_downloading",
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

function reportDownloadCacheHit(options: DownloadToFileOptions): void {
  options.onProgress?.({
    progressText: tMain("downloads.cached", { label: options.label }),
    detail: options.label,
    progressMode: "log-only",
    installLogLine: tMain("downloads.cachedLog", { label: options.label }),
  });
}
