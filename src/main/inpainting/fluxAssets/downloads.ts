import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { FluxAssetProgress, NvidiaRedistPackage } from "./types";
import { throwIfAborted, runCommand } from "./errors";
import { tMain } from "../localization";
import { isPathInside } from "../../runtimeSupport/fileProbe";
import { downloadToFile } from "../../runtimeSupport/modelDownloads";
import { MAX_REMOTE_RUNTIME_ARCHIVE_BYTES } from "../../runtimeSupport/downloadBudgets";
import {
  createLinkedDeadlineController,
  readBoundedResponseText,
} from "../../httpResponseBudget";
import { MAX_RUNTIME_MANIFEST_BYTES } from "../../networkBudgets";

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
  const size = readManifestFileSize(record.size);
  return {
    relative_path: relativePath,
    ...(size === undefined ? {} : { size }),
  };
}

function readManifestFileSize(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("NVIDIA runtime manifest에 잘못된 파일 크기가 있습니다.");
  }
  return Number(value);
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
