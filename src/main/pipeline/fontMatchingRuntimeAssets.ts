/**
 * Font matching runtime asset externalization.
 *
 * The trained font matching runtime bundle (7 files, ~467 MiB — dominated by
 * `encoder.onnx` at 465 MiB) is NOT bundled in the installer. Instead it is
 * downloaded on first use into a writable cache under the persistent data root
 * and the existing fail-closed bundle verification (`readVerifiedRuntimeArtifactBundle`)
 * runs on the cached directory. This mirrors the bubble-detection runtime
 * download pattern (`ensureComicBubbleDetectorAssets` / `ensureRemoteFile`).
 *
 * Trust root: the 7 hardcoded SHA-256 digests below (protected by asar
 * integrity). `ensureRemoteFile` verifies each downloaded file against its
 * digest before use; `readVerifiedRuntimeArtifactBundle` then re-verifies the
 * bundle self-consistently against the downloaded marker. The marker's own
 * digest is the primary anchor — the marker internally pins the other 6.
 *
 * Dev keeps the staged bundle at `out/app-runtime/font-matching` (prepared by
 * `scripts/prepare-runtime.cjs`); `resolveFontMatchingArtifactDirSync` prefers
 * that directory when its marker is present and only falls back to the cache
 * (download) in packaged mode where the bundle is excluded from the installer.
 */
import { existsSync } from "node:fs";
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
  FONT_MATCHING_RUNTIME_MARKER_FILE,
} from "./fontMatchingRuntimePaths";

/**
 * Dedicated, app-version-independent GitHub Release tag hosting the runtime
 * bundle assets. Mirrors the `flux-runners-cuda12.9` pattern. A future bundle
 * revision ships under a new tag + new digest constants, so the same cached
 * 465 MiB download is reused across app releases that pin this tag.
 */
const FONT_MATCHING_RUNTIME_RELEASE_TAG = "font-matching-runtime-v1";
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
};

export const FONT_MATCHING_RUNTIME_FILES: readonly FontMatchingRuntimeFile[] = [
  {
    fileName: FONT_MATCHING_RUNTIME_MARKER_FILE,
    urlName: "default.font-matching-runtime-artifact-owned.json",
    sha256: "e78fdd46cf3715ac985ba04335b1c680d93bb215fd62c2683ccd312c43b53f14",
    bytes: 755,
  },
  {
    fileName: "runtime-contract.json",
    sha256: "01b245d58a5ad858068726d1875e64add53dc4a084c78be0342dc6858b9ede66",
    bytes: 27_025,
  },
  {
    fileName: "auto-match-active-catalog.json",
    sha256: "59f7ed49e2ca75d537a3dd4d91aff6d89175c885c45ca8f06b0b0f754ac45676",
    bytes: 19_942,
  },
  {
    fileName: "selection-calibration.json",
    sha256: "d2e97f6a5dec0bf28f13d8f78cfd70a99bf31bd90ab30d243196b5cba5ce06d3",
    bytes: 12_912,
  },
  {
    fileName: "ranker.onnx",
    sha256: "340a4aee2d223c8a3d1f7a9725118a81cd43bee745fbae7b50fb7e4ec3f489f5",
    bytes: 51_490,
  },
  {
    fileName: "prototype-features.f32",
    sha256: "cb4479cd7a48f052698235fd427c7fd90a91fb4ec47e74316bd574b1ffd7bcd3",
    bytes: 1_720_320,
  },
  {
    fileName: "encoder.onnx",
    sha256: "8b9db6bbe272510cedc0f5ce37ce0d1d7f90c146b7c42dd07ca14c26eff4a985",
    bytes: 487_357_925,
  },
];

/**
 * Download all 7 bundle files into the cache directory under `dataRoot`, each
 * SHA-256-verified against the hardcoded digest via `ensureRemoteFile` (which
 * also writes a `.mgtmeta.json` sidecar for a resumable cache-hit fast path).
 * Files are fetched sequentially small-first so the encoder dominates the
 * progress timeline and the determinate progress bar stays unambiguous.
 */
export async function ensureFontMatchingRuntimeAssets(options: {
  dataRoot: string;
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
    await ensureRemoteFile({
      modelDir: cacheDir,
      url: `${FONT_MATCHING_RUNTIME_BASE_URL}/${file.urlName ?? file.fileName}`,
      fileName: file.fileName,
      label: `font-matching-runtime/${file.fileName}`,
      expectedSha256: file.sha256,
      minimumBytes: file.bytes,
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
  if (existsSync(join(bundledDir, FONT_MATCHING_RUNTIME_MARKER_FILE))) {
    return;
  }
  await ensureFontMatchingRuntimeAssets({
    dataRoot: options.paths.dataRoot,
    signal: options.signal,
    onProgress: options.onProgress,
  });
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
