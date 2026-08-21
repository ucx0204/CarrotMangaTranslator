/**
 * Font matching runtime asset externalization.
 *
 * The v3 trust files and R33 ranker are bundled, while the unchanged large
 * encoder/prototype/catalog assets are verified and either migrated from the
 * byte-identical v1 cache or downloaded from the immutable v2 asset release
 * into a new writable cache. The completed seven-file
 * cache is then verified as one bundle by `readVerifiedRuntimeArtifactBundle`.
 *
 * Trust root: the 7 hardcoded SHA-256 digests below (protected by asar
 * integrity). `ensureRemoteFile` verifies each downloaded file against its
 * digest before use; `readVerifiedRuntimeArtifactBundle` then re-verifies the
 * bundle self-consistently against the downloaded marker. The marker's own
 * digest is the primary anchor — the marker internally pins the other 6.
 *
 * Dev stages the complete bundle at `out/app-runtime/font-matching`. Packaged
 * builds contain only the four small v3 files there; path resolution therefore
 * selects the completed data-root cache until all seven files exist.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import { logWarn } from "../logger";
import {
  ensureRemoteFile,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import type { PipelineOptions } from "./types";
import {
  FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  FONT_MATCHING_RUNTIME_BUNDLE_FILES,
  FONT_MATCHING_RUNTIME_MARKER_FILE,
} from "./fontMatchingRuntimePaths";

/**
 * Immutable asset-only GitHub prerelease hosting the byte-identical shared
 * assets. The installer carries the four small v3 trust/ranker files;
 * the three large files use this tag on a fresh install. A byte-identical v1
 * cache may still be migrated locally to avoid a redundant 467 MiB download.
 */
export const FONT_MATCHING_RUNTIME_RELEASE_TAG = "font-matching-runtime-v2";
export const FONT_MATCHING_RUNTIME_BASE_URL = `https://github.com/ucx0204/CarrotMangaTranslator/releases/download/${FONT_MATCHING_RUNTIME_RELEASE_TAG}`;

/** Ordered small-first so the encoder dominates the download timeline. */
type FontMatchingRuntimeFile = {
  /** Cache-side filename (the canonical bundle name). */
  fileName: string;
  /**
   * Optional release-asset filename when GitHub Releases renames the asset
   * on upload. GitHub strips a leading dot and prefixes `default.`, so the
   * marker (`.font-matching-runtime-artifact-owned.json`) is hosted as
   * `default.font-matching-runtime-artifact-owned.json` but must cache under
   * its canonical dot-name. Defaults to `fileName`.
   */
  urlName?: string;
  sha256: string;
  bytes: number;
  source: "bundled-v3" | "remote-v2-release";
};

export const FONT_MATCHING_RUNTIME_FILES: readonly FontMatchingRuntimeFile[] = [
  {
    fileName: FONT_MATCHING_RUNTIME_MARKER_FILE,
    urlName: "default.font-matching-runtime-artifact-owned.json",
    sha256: "3477b25beed9a2518fe024a5b6b8d766c3593f7aefe58a3e65cdc3ac71a0cd2b",
    bytes: 755,
    source: "bundled-v3",
  },
  {
    fileName: "runtime-contract.json",
    sha256: "f1ec598247f86904072c0615ec38f7efe4eab3950268206cae5fa9e9ffc5f52a",
    bytes: 23_401,
    source: "bundled-v3",
  },
  {
    fileName: "auto-match-active-catalog.json",
    sha256: "59f7ed49e2ca75d537a3dd4d91aff6d89175c885c45ca8f06b0b0f754ac45676",
    bytes: 19_942,
    source: "remote-v2-release",
  },
  {
    fileName: "selection-calibration.json",
    sha256: "aaaaa938d5fbed6070115b2d206c6cc4a35517b3b11061fb0a4d11383caa5660",
    bytes: 19_146,
    source: "bundled-v3",
  },
  {
    fileName: "ranker.onnx",
    sha256: "e049fc74c3baeeee9aba179412a3b20387304b749936c167ecc753afcc78f4aa",
    bytes: 647_571,
    source: "bundled-v3",
  },
  {
    fileName: "prototype-features.f32",
    sha256: "cb4479cd7a48f052698235fd427c7fd90a91fb4ec47e74316bd574b1ffd7bcd3",
    bytes: 1_720_320,
    source: "remote-v2-release",
  },
  {
    fileName: "encoder.onnx",
    sha256: "8b9db6bbe272510cedc0f5ce37ce0d1d7f90c146b7c42dd07ca14c26eff4a985",
    bytes: 487_357_925,
    source: "remote-v2-release",
  },
];

const SHARED_CACHE_VERSIONS = [
  "active21-v8-r3h-manual-v2-release-v1",
  "active21-r5-e1-release-v1",
] as const;

/**
 * Download all 7 bundle files into the cache directory under `dataRoot`, each
 * SHA-256-verified against the hardcoded digest via `ensureRemoteFile` (which
 * also writes a `.mgtmeta.json` sidecar for a resumable cache-hit fast path).
 * Files are fetched sequentially small-first so the encoder dominates the
 * progress timeline and the determinate progress bar stays unambiguous.
 */
export async function ensureFontMatchingRuntimeAssets(options: {
  dataRoot: string;
  bundledDir?: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string> {
  const cacheDir = join(
    options.dataRoot,
    "models",
    "font-matching",
    FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  );
  for (const file of FONT_MATCHING_RUNTIME_FILES) {
    throwIfAborted(options.signal);
    if (file.source === "bundled-v3") {
      if (!options.bundledDir) {
        throw new Error(
          "Bundled font runtime directory is required for v3 trust files",
        );
      }
      await installVerifiedBundledFile({
        sourcePath: join(options.bundledDir, file.fileName),
        destinationPath: join(cacheDir, file.fileName),
        expectedSha256: file.sha256,
        expectedBytes: file.bytes,
      });
      continue;
    }
    let migrated = false;
    for (const cacheVersion of SHARED_CACHE_VERSIONS) {
      migrated = await installVerifiedBundledFile({
        sourcePath: join(
          options.dataRoot,
          "models",
          "font-matching",
          cacheVersion,
          file.fileName,
        ),
        destinationPath: join(cacheDir, file.fileName),
        expectedSha256: file.sha256,
        expectedBytes: file.bytes,
        optionalSource: true,
      });
      if (migrated) break;
    }
    if (migrated) continue;
    await ensureRemoteFile({
      modelDir: cacheDir,
      url: `${FONT_MATCHING_RUNTIME_BASE_URL}/${file.urlName ?? file.fileName}`,
      fileName: file.fileName,
      label: `font-matching-runtime/${file.fileName}`,
      expectedSha256: file.sha256,
      minimumBytes: file.bytes,
      expectedTotalBytes: file.bytes,
      maximumBytes: file.bytes,
      progressPhase: "font_matching_downloading",
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }
  return cacheDir;
}

/**
 * Job-preparation entry point. If the staged dev bundle is present (marker
 * file in `runtimeDir/font-matching`), this is a no-op — dev uses the local
 * staged bundle without downloading. Otherwise it downloads the bundle into
 * the writable cache. Non-abort download failures are rethrown so the caller
 * can degrade fail-closed (the font matching stack already handles a missing
 * bundle gracefully); abort propagates as `AbortError`.
 */
export async function prepareFontMatchingRuntime(options: {
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<void> {
  const bundledDir = join(options.paths.runtimeDir, "font-matching");
  if (
    FONT_MATCHING_RUNTIME_BUNDLE_FILES.every((fileName) =>
      existsSync(join(bundledDir, fileName)),
    )
  ) {
    return;
  }
  await ensureFontMatchingRuntimeAssets({
    dataRoot: options.paths.dataRoot,
    bundledDir,
    signal: options.signal,
    onProgress: options.onProgress,
  });
}

async function installVerifiedBundledFile(options: {
  sourcePath: string;
  destinationPath: string;
  expectedSha256: string;
  expectedBytes: number;
  optionalSource?: boolean;
}): Promise<boolean> {
  if (!existsSync(options.sourcePath)) {
    if (options.optionalSource) return false;
    throw new Error(
      `Bundled font runtime file is missing: ${options.sourcePath}`,
    );
  }
  if (await isExactRuntimeFile(options.destinationPath, options)) return true;
  if (!(await isExactRuntimeFile(options.sourcePath, options))) {
    if (options.optionalSource) return false;
    throw new Error(
      `Bundled font runtime file is invalid: ${options.sourcePath}`,
    );
  }
  await mkdir(join(options.destinationPath, ".."), { recursive: true });
  const temporary = `${options.destinationPath}.part`;
  try {
    await unlinkIfPresent(temporary);
    await copyFile(options.sourcePath, temporary);
    if (!(await isExactRuntimeFile(temporary, options))) {
      throw new Error(`Copied font runtime file is invalid: ${temporary}`);
    }
    await unlinkIfPresent(options.destinationPath);
    await rename(temporary, options.destinationPath);
    return true;
  } finally {
    await unlinkIfPresent(temporary);
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logWarn("Failed to clean up a font runtime asset file", { path, error });
    }
  }
}

async function isExactRuntimeFile(
  path: string,
  expected: { expectedSha256: string; expectedBytes: number },
): Promise<boolean> {
  try {
    const [metadata, bytes] = await Promise.all([lstat(path), readFile(path)]);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.size === expected.expectedBytes &&
      createHash("sha256").update(bytes).digest("hex") ===
        expected.expectedSha256
    );
  } catch (_error) {
    return false;
  }
}

/**
 * Pipeline-facing wrapper around `prepareFontMatchingRuntime`: no-op when auto
 * font matching is off or the caller injected its own dependencies (tests), and
 * emits `font_matching_downloading` job progress while downloading. Keeps the
 * download prep out of `runWholePagePipeline` so that function stays under its
 * line/complexity budgets. Non-abort failures degrade fail-closed — translation
 * proceeds without auto font matching; abort propagates to cancel the job.
 */
export async function prepareFontMatchingRuntimeForRun(
  options: Pick<
    PipelineOptions,
    "signal" | "jobId" | "emit" | "autoFontMatching"
  >,
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">,
  injected: boolean,
): Promise<void> {
  if (!options.autoFontMatching || injected) return;
  try {
    await prepareFontMatchingRuntime({
      paths,
      signal: options.signal,
      onProgress: (progress) =>
        options.emit({
          id: options.jobId,
          kind: "gemma-analysis",
          status: "starting",
          progressText: progress.progressText,
          phase: "font_matching_downloading",
          progressMode: progress.progressMode,
          progressPercent: progress.progressPercent,
          progressBytes: progress.progressBytes,
          progressTotalBytes: progress.progressTotalBytes,
          detail: progress.detail,
          installLogLine: progress.installLogLine,
        }),
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    logWarn(
      "Font matching runtime download failed; auto font matching disabled for this run.",
      error,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
