/**
 * Font matching runtime asset externalization.
 *
 * Every runtime file is external to the installer. The unchanged large
 * encoder/prototype/catalog assets stay on the immutable v2 asset release;
 * the R33 trust/ranker files use their own immutable prerelease. Exact local
 * cache files may be migrated to avoid redundant downloads. The completed
 * seven-file cache is verified as one bundle by
 * `readVerifiedRuntimeArtifactBundle`.
 *
 * Trust root: the 7 hardcoded SHA-256 digests below (protected by asar
 * integrity). `ensureRemoteFile` verifies each downloaded file against its
 * digest before use; `readVerifiedRuntimeArtifactBundle` then re-verifies the
 * bundle self-consistently against the downloaded marker. The marker's own
 * digest is the primary anchor — the marker internally pins the other 6.
 *
 * Dev may stage the complete bundle at `out/app-runtime/font-matching`.
 * Packaged builds exclude the entire directory and always use the writable
 * data-root cache.
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
  ensureCrossScriptProxyRuntimeAssets,
  hasCompleteBundledCrossScriptProxyRuntime,
} from "./fontMatchingCrossScriptProxyAssets";
import {
  FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  FONT_MATCHING_RUNTIME_BUNDLE_FILES,
  FONT_MATCHING_RUNTIME_MARKER_FILE,
} from "./fontMatchingRuntimePaths";
import {
  FONT_MATCHING_RUNTIME_BASE_URL,
  FONT_MATCHING_RUNTIME_RELEASE_TAG,
  FONT_MATCHING_SHARED_BASE_URL,
  FONT_MATCHING_SHARED_RELEASE_TAG,
} from "./fontMatchingRuntimeRelease";

export {
  FONT_MATCHING_RUNTIME_BASE_URL,
  FONT_MATCHING_RUNTIME_RELEASE_TAG,
  FONT_MATCHING_SHARED_BASE_URL,
  FONT_MATCHING_SHARED_RELEASE_TAG,
};

/**
 * The current R33 release hosts the four small trust/ranker files and the
 * cross-script proxy. The unchanged large files continue to use the shared v2
 * release so immutable bytes are not uploaded under a second tag.
 */
/** Ordered small-first so the encoder dominates the download timeline. */
type FontMatchingRuntimeFile = {
  /** Cache-side filename (the canonical bundle name). */
  fileName: string;
  /** Optional release-asset filename when it differs from the cache name. */
  urlName?: string;
  sha256: string;
  bytes: number;
  release: "r33" | "shared-v2";
};

export const FONT_MATCHING_RUNTIME_FILES: readonly FontMatchingRuntimeFile[] = [
  {
    fileName: FONT_MATCHING_RUNTIME_MARKER_FILE,
    urlName: "font-matching-r33-artifact-owned.json",
    sha256: "3477b25beed9a2518fe024a5b6b8d766c3593f7aefe58a3e65cdc3ac71a0cd2b",
    bytes: 755,
    release: "r33",
  },
  {
    fileName: "runtime-contract.json",
    urlName: "font-matching-r33-runtime-contract.json",
    sha256: "f1ec598247f86904072c0615ec38f7efe4eab3950268206cae5fa9e9ffc5f52a",
    bytes: 23_401,
    release: "r33",
  },
  {
    fileName: "auto-match-active-catalog.json",
    sha256: "59f7ed49e2ca75d537a3dd4d91aff6d89175c885c45ca8f06b0b0f754ac45676",
    bytes: 19_942,
    release: "shared-v2",
  },
  {
    fileName: "selection-calibration.json",
    urlName: "font-matching-r33-selection-calibration.json",
    sha256: "aaaaa938d5fbed6070115b2d206c6cc4a35517b3b11061fb0a4d11383caa5660",
    bytes: 19_146,
    release: "r33",
  },
  {
    fileName: "ranker.onnx",
    urlName: "font-matching-r33-ranker.onnx",
    sha256: "e049fc74c3baeeee9aba179412a3b20387304b749936c167ecc753afcc78f4aa",
    bytes: 647_571,
    release: "r33",
  },
  {
    fileName: "prototype-features.f32",
    sha256: "cb4479cd7a48f052698235fd427c7fd90a91fb4ec47e74316bd574b1ffd7bcd3",
    bytes: 1_720_320,
    release: "shared-v2",
  },
  {
    fileName: "encoder.onnx",
    sha256: "8b9db6bbe272510cedc0f5ce37ce0d1d7f90c146b7c42dd07ca14c26eff4a985",
    bytes: 487_357_925,
    release: "shared-v2",
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
    const baseUrl =
      file.release === "r33"
        ? FONT_MATCHING_RUNTIME_BASE_URL
        : FONT_MATCHING_SHARED_BASE_URL;
    await ensureRemoteFile({
      modelDir: cacheDir,
      url: `${baseUrl}/${file.urlName ?? file.fileName}`,
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
 * Job-preparation entry point. Complete development bundles remain usable,
 * while packaged builds download both font runtimes into writable caches.
 * Non-abort download failures are rethrown so the caller can degrade
 * fail-closed; abort propagates as `AbortError`.
 */
export async function prepareFontMatchingRuntime(options: {
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<void> {
  const bundledDir = join(options.paths.runtimeDir, "font-matching");
  const hasBundledRuntime = FONT_MATCHING_RUNTIME_BUNDLE_FILES.every(
    (fileName) => existsSync(join(bundledDir, fileName)),
  );
  if (!hasBundledRuntime) {
    await ensureFontMatchingRuntimeAssets({
      dataRoot: options.paths.dataRoot,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }
  if (!hasCompleteBundledCrossScriptProxyRuntime(options.paths)) {
    await ensureCrossScriptProxyRuntimeAssets({
      dataRoot: options.paths.dataRoot,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }
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
