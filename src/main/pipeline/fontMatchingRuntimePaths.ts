/**
 * Worker-safe font matching runtime path resolution.
 *
 * This module is the pure, dependency-light half of the font matching runtime
 * externalization: the constants and the synchronous artifact-directory
 * resolver. It deliberately imports ONLY `node:fs`, `node:path`, and the
 * `AppPaths` *type* — never `../logger` and never `electron` — so it is safe to
 * load from the font matching inference worker, which runs as a forked Node
 * process (`ELECTRON_RUN_AS_NODE=1`) where `require("electron")` throws
 * `MODULE_NOT_FOUND`.
 *
 * The download/prep half (`prepareFontMatchingRuntime`, `ensureRemoteFile`
 * wiring, `logWarn`) lives in `fontMatchingRuntimeAssets.ts`, which is only
 * loaded from the main process and re-exports these symbols for back-compat.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AppPaths } from "../appPaths";

/**
 * Cache directory segment under `dataRoot/models/font-matching/`. Matches the
 * source artifact directory suffix in `scripts/prepare-runtime.cjs` so a future
 * bundle revision coexists without invalidating this cache.
 */
export const FONT_MATCHING_RUNTIME_BUNDLE_VERSION =
  "active21-v8-r3h-manual-v2-release-v1";

export const FONT_MATCHING_RUNTIME_MARKER_FILE =
  ".font-matching-runtime-artifact-owned.json";

/** Exact inventory required before a staged directory may bypass cache prep. */
export const FONT_MATCHING_RUNTIME_BUNDLE_FILES = [
  FONT_MATCHING_RUNTIME_MARKER_FILE,
  "runtime-contract.json",
  "auto-match-active-catalog.json",
  "selection-calibration.json",
  "ranker.onnx",
  "prototype-features.f32",
  "encoder.onnx",
] as const;

/**
 * Resolve the directory the font matching runtime bundle lives in, WITHOUT
 * downloading. In dev the staged `runtimeDir/font-matching` bundle (marker
 * present) is preferred; in packaged mode the bundle is excluded from the
 * installer so the marker is absent and the cache directory under the writable
 * data root is returned. Callers must run `prepareFontMatchingRuntime` (or
 * rely on the fail-closed stack) before reading the bundle from the cache path.
 */
export function resolveFontMatchingArtifactDirSync(
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">,
): string {
  const bundledDir = join(paths.runtimeDir, "font-matching");
  if (
    FONT_MATCHING_RUNTIME_BUNDLE_FILES.every((fileName) =>
      existsSync(join(bundledDir, fileName)),
    )
  ) {
    return bundledDir;
  }
  return join(
    paths.dataRoot,
    "models",
    "font-matching",
    FONT_MATCHING_RUNTIME_BUNDLE_VERSION,
  );
}
