import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import * as path from "node:path";
import type { FluxAssetProgress, NvidiaRedistPackage } from "./types";
import { throwIfAborted, runCommand } from "./errors";
import { emitDownloadProgress, formatBytes } from "./progress";
import { safeCleanup } from "../../safeCleanup";
import { tMain } from "../localization";
import {
  isPathInside,
  isUsableRemoteFile,
  writeRemoteFileMetadata,
} from "./fileProbe";

const AdmZip = require("adm-zip");

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

export function hfResolveUrl(repo: string, fileName: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(fileName)}`;
}

export async function ensureRemoteFile(options: {
  modelDir: string;
  url: string;
  fileName: string;
  label: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const filePath = path.join(options.modelDir, options.fileName);
  if (await isUsableRemoteFile(filePath, options.url)) {
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
  await downloadToFile({
    url: options.url,
    outputPath: filePath,
    signal: options.signal,
    progressText: tMain("downloads.downloading", { label: options.label }),
    label: options.fileName,
    onProgress: options.onProgress,
  });
  return filePath;
}

type DownloadToFileOptions = {
  url: string;
  outputPath: string;
  signal?: AbortSignal;
  progressText: string;
  label: string;
  onProgress?: (progress: FluxAssetProgress) => void;
};

type DownloadWriteResult = {
  receivedBytes: number;
  responseTotalBytes: number;
};

type DownloadResponse = Response & {
  body: ReadableStream<Uint8Array>;
};

export async function downloadToFile(
  options: DownloadToFileOptions,
): Promise<void> {
  if (await isUsableRemoteFile(options.outputPath, options.url)) {
    reportDownloadCacheHit(options);
    return;
  }
  const partPath = await prepareDownloadTarget(options.outputPath);
  const totalBytes = await probeContentLength(options.url, options.signal);
  reportDownloadStart(options, totalBytes);
  const response = await fetchDownloadResponse(options);
  const result = await writeDownloadResponseToPartFile(
    options,
    partPath,
    response,
    totalBytes,
  );
  await finalizeDownload(options, partPath, result);
}

function reportDownloadCacheHit(options: DownloadToFileOptions): void {
  options.onProgress?.({
    progressText: tMain("downloads.cached", { label: options.label }),
    detail: options.label,
    progressMode: "log-only",
    installLogLine: tMain("downloads.cachedLog", { label: options.label }),
  });
}

async function prepareDownloadTarget(outputPath: string): Promise<string> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const partPath = `${outputPath}.part`;
  await rm(partPath, { force: true });
  return partPath;
}

function reportDownloadStart(
  options: DownloadToFileOptions,
  totalBytes: number,
): void {
  options.onProgress?.({
    progressText: options.progressText,
    detail: options.label,
    progressMode: totalBytes > 0 ? "determinate" : "log-only",
    progressPercent: totalBytes > 0 ? 0 : undefined,
    progressBytes: totalBytes > 0 ? 0 : undefined,
    progressTotalBytes: totalBytes > 0 ? totalBytes : undefined,
    installLogLine: tMain("downloads.startedLog", { label: options.label }),
  });
}

async function fetchDownloadResponse(
  options: DownloadToFileOptions,
): Promise<DownloadResponse> {
  const response = await fetch(options.url, {
    signal: options.signal,
    headers: { "User-Agent": "carrot-manga-translator" },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      tMain("downloads.failed", {
        label: options.label,
        status: response.status,
      }),
    );
  }
  return response as DownloadResponse;
}

async function writeDownloadResponseToPartFile(
  options: DownloadToFileOptions,
  partPath: string,
  response: DownloadResponse,
  totalBytes: number,
): Promise<DownloadWriteResult> {
  const responseTotalBytes = totalBytes || readContentLength(response);
  const reader = response.body.getReader();
  const writer = createWriteStream(partPath, { flags: "wx" });
  let receivedBytes = 0;
  let lastEmitAt = 0;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      await writeStreamChunk(writer, chunk);
      receivedBytes += chunk.byteLength;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        emitDownloadProgress(options, receivedBytes, responseTotalBytes);
      }
    }
    await finishWriteStream(writer);
    if (responseTotalBytes > 0 && receivedBytes !== responseTotalBytes) {
      throw new Error(
        tMain("downloads.sizeMismatch", {
          label: options.label,
          received: formatBytes(receivedBytes),
          total: formatBytes(responseTotalBytes),
        }),
      );
    }
    return { receivedBytes, responseTotalBytes };
  } catch (error) {
    writer.destroy();
    await safeCleanup("remove partial Flux download", () =>
      rm(partPath, { force: true }),
    );
    throw error;
  }
}

async function finalizeDownload(
  options: DownloadToFileOptions,
  partPath: string,
  result: DownloadWriteResult,
): Promise<void> {
  const { receivedBytes, responseTotalBytes } = result;
  await rm(options.outputPath, { force: true });
  await rename(partPath, options.outputPath);
  await writeRemoteFileMetadata(options.outputPath, {
    url: options.url,
    bytes: receivedBytes,
    downloadedAt: new Date().toISOString(),
  });
  emitDownloadProgress(
    options,
    responseTotalBytes > 0 ? responseTotalBytes : receivedBytes,
    responseTotalBytes || receivedBytes,
    true,
  );
}

async function probeContentLength(
  url: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const response = await fetch(url, { method: "HEAD", signal });
    return response.ok ? readContentLength(response) : 0;
  } catch (_error) {
    return 0;
  }
}

function readContentLength(response: Response): number {
  const value = Number(response.headers.get("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function writeStreamChunk(
  writer: ReturnType<typeof createWriteStream>,
  chunk: Buffer,
): Promise<void> {
  if (writer.write(chunk)) {
    return;
  }
  await once(writer, "drain");
}

async function finishWriteStream(
  writer: ReturnType<typeof createWriteStream>,
): Promise<void> {
  writer.end();
  await once(writer, "finish");
}
