import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_REMOTE_RUNTIME_ARCHIVE_BYTES } from "../../runtimeSupport/downloadBudgets";
import { isUsableFile } from "../../runtimeSupport/fileProbe";
import { downloadToFile } from "../../runtimeSupport/modelDownloads";
import {
  FLUX_ROCM_PREBUILT_RUNTIME_BYTES,
  FLUX_ROCM_PREBUILT_RUNTIME_PARTS,
  FLUX_ROCM_PREBUILT_RUNTIME_URL,
} from "./constants";
import type { FluxAssetProgress } from "./types";

type EnsureFluxRocmArchiveOptions = {
  urlOrPath: string;
  outputPath: string;
  signal?: AbortSignal;
  label: string;
  expectedSha256: string;
  usePinnedDefaultParts: boolean;
  onProgress?: (progress: FluxAssetProgress) => void;
};

export async function ensurePrebuiltFluxRocmRuntimeArchive(
  options: EnsureFluxRocmArchiveOptions,
): Promise<string> {
  const parsed = parseMaybeUrl(options.urlOrPath);
  if (parsed && ["http:", "https:"].includes(parsed.protocol)) {
    return ensureRemoteFluxRocmArchive(options);
  }
  return ensureLocalFluxRocmArchive(options, parsed);
}

async function ensureRemoteFluxRocmArchive(
  options: EnsureFluxRocmArchiveOptions,
): Promise<string> {
  if (options.usePinnedDefaultParts) {
    return ensurePinnedMultipartFluxRocmArchive(options);
  }
  await downloadToFile({
    url: options.urlOrPath,
    outputPath: options.outputPath,
    signal: options.signal,
    progressText: "Flux ROCm prebuilt 런타임 다운로드 중",
    label: options.label,
    expectedSha256: options.expectedSha256,
    maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
    onProgress: options.onProgress,
  });
  await assertPrebuiltArchiveSha256(
    options.outputPath,
    options.expectedSha256,
    options.signal,
  );
  return options.outputPath;
}

async function ensureLocalFluxRocmArchive(
  options: EnsureFluxRocmArchiveOptions,
  parsed: URL | null,
): Promise<string> {
  const sourcePath = normalizeLocalArchivePath(options.urlOrPath, parsed);
  if (!isUsableFile(sourcePath)) {
    throw new Error(
      `Flux ROCm prebuilt 런타임 파일을 찾지 못했습니다: ${options.urlOrPath}`,
    );
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  await copyFile(sourcePath, options.outputPath);
  await assertPrebuiltArchiveSha256(
    options.outputPath,
    options.expectedSha256,
    options.signal,
  );
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 파일 복사 완료",
    detail: basename(sourcePath),
    progressMode: "log-only",
    installLogLine: `로컬 Flux ROCm prebuilt 런타임을 사용합니다: ${sourcePath}`,
  });
  return options.outputPath;
}

function normalizeLocalArchivePath(value: string, parsed: URL | null): string {
  const sourcePath =
    parsed?.protocol === "file:" ? decodeURIComponent(parsed.pathname) : value;
  return process.platform === "win32" &&
    sourcePath.startsWith("/") &&
    /^[A-Za-z]:/.test(sourcePath.slice(1))
    ? sourcePath.slice(1)
    : sourcePath;
}

async function ensurePinnedMultipartFluxRocmArchive(
  options: EnsureFluxRocmArchiveOptions,
): Promise<string> {
  if (await matchesExpectedPinnedArchive(options)) {
    reportPinnedArchiveCacheHit(options);
    return options.outputPath;
  }
  await rm(options.outputPath, { force: true });
  const partsDir = `${options.outputPath}.parts`;
  await mkdir(partsDir, { recursive: true });
  const partPaths = await downloadPinnedArchiveParts(options, partsDir);
  await assembleFluxRocmRuntimeArchiveParts({
    partPaths,
    outputPath: options.outputPath,
    expectedBytes: FLUX_ROCM_PREBUILT_RUNTIME_BYTES,
    expectedSha256: options.expectedSha256,
    signal: options.signal,
  });
  await rm(partsDir, { recursive: true, force: true });
  return options.outputPath;
}

async function downloadPinnedArchiveParts(
  options: EnsureFluxRocmArchiveOptions,
  partsDir: string,
): Promise<string[]> {
  const partPaths: string[] = [];
  for (const [index, part] of FLUX_ROCM_PREBUILT_RUNTIME_PARTS.entries()) {
    const partPath = join(partsDir, part.fileName);
    partPaths.push(partPath);
    await downloadToFile({
      url: new URL(part.fileName, FLUX_ROCM_PREBUILT_RUNTIME_URL).toString(),
      outputPath: partPath,
      signal: options.signal,
      progressText: `Flux ROCm prebuilt 런타임 다운로드 중 (${index + 1}/${FLUX_ROCM_PREBUILT_RUNTIME_PARTS.length})`,
      label: part.fileName,
      expectedSha256: part.sha256,
      expectedTotalBytes: part.bytes,
      maximumBytes: part.bytes,
      onProgress: options.onProgress,
    });
  }
  return partPaths;
}

export async function assembleFluxRocmRuntimeArchiveParts(options: {
  partPaths: string[];
  outputPath: string;
  expectedBytes: number;
  expectedSha256: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (options.partPaths.length === 0) {
    throw new Error("Flux ROCm runtime archive has no release parts.");
  }
  const stagingPath = `${options.outputPath}.assembling-${process.pid}-${Date.now()}`;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await rm(stagingPath, { force: true });
  const hash = createHash("sha256");
  const state = { bytes: 0 };
  try {
    await writeArchiveParts(options, stagingPath, hash, state);
    assertAssembledArchive(options, state.bytes, hash.digest("hex"));
    await rm(options.outputPath, { force: true });
    await rename(stagingPath, options.outputPath);
  } catch (error) {
    await rm(stagingPath, { force: true });
    throw error;
  }
}

async function writeArchiveParts(
  options: {
    partPaths: string[];
    expectedBytes: number;
    signal?: AbortSignal;
  },
  stagingPath: string,
  hash: ReturnType<typeof createHash>,
  state: { bytes: number },
): Promise<void> {
  for (const [index, partPath] of options.partPaths.entries()) {
    await pipeline(
      createReadStream(partPath),
      createArchiveMeter(options.expectedBytes, hash, state),
      createWriteStream(stagingPath, {
        flags: index === 0 ? "wx" : "a",
        mode: 0o600,
      }),
      { signal: options.signal },
    );
  }
}

function createArchiveMeter(
  expectedBytes: number,
  hash: ReturnType<typeof createHash>,
  state: { bytes: number },
): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.bytes += chunk.length;
      if (state.bytes > expectedBytes) {
        callback(
          new Error("Flux ROCm runtime release parts exceed expected size."),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

function assertAssembledArchive(
  options: { expectedBytes: number; expectedSha256: string },
  actualBytes: number,
  actualSha256: string,
): void {
  if (actualBytes !== options.expectedBytes) {
    throw new Error(
      `Flux ROCm runtime release parts size mismatch. expected=${options.expectedBytes}, actual=${actualBytes}`,
    );
  }
  if (actualSha256 !== options.expectedSha256) {
    throw new Error(
      `Flux ROCm runtime release parts SHA-256 mismatch. expected=${options.expectedSha256}, actual=${actualSha256}`,
    );
  }
}

async function matchesExpectedPinnedArchive(
  options: EnsureFluxRocmArchiveOptions,
): Promise<boolean> {
  try {
    if (
      (await stat(options.outputPath)).size !== FLUX_ROCM_PREBUILT_RUNTIME_BYTES
    ) {
      return false;
    }
    return (
      (await sha256File(options.outputPath, options.signal)) ===
      options.expectedSha256
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : error;
    }
    return false;
  }
}

async function assertPrebuiltArchiveSha256(
  archivePath: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> {
  const actualSha256 = await sha256File(archivePath, signal);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Flux ROCm prebuilt runtime SHA-256 mismatch. expected=${expectedSha256}, actual=${actualSha256}`,
    );
  }
}

async function sha256File(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException(
            "Flux ROCm runtime verification aborted",
            "AbortError",
          );
    }
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function reportPinnedArchiveCacheHit(
  options: EnsureFluxRocmArchiveOptions,
): void {
  options.onProgress?.({
    progressText: "Flux ROCm prebuilt 런타임 캐시 확인 완료",
    detail: options.label,
    progressMode: "log-only",
    installLogLine: `검증된 Flux ROCm prebuilt 런타임을 재사용합니다: ${options.label}`,
  });
}

export function resolveArchiveFileName(
  urlOrPath: string,
  fallback: string,
): string {
  const parsed = parseMaybeUrl(urlOrPath);
  if (parsed) {
    return basename(decodeURIComponent(parsed.pathname)) || fallback;
  }
  return basename(urlOrPath) || fallback;
}

function parseMaybeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch (_error) {
    return null;
  }
}
