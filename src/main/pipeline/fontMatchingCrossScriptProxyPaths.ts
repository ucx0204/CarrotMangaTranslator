import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppPaths } from "../appPaths";

export const CROSS_SCRIPT_PROXY_RUNTIME_VERSION =
  "manga-font-crossscript-proxy-runtime-v2";

export const CROSS_SCRIPT_PROXY_RUNTIME_FILES = [
  ".owned.json",
  "runtime-manifest.json",
  "style-encoder.onnx",
  "glyph-decoder.onnx",
  "candidate-glyphs.u8",
] as const;

/** Prefer a complete development bundle; packaged builds use writable cache. */
export function resolveCrossScriptProxyRuntimeDir(
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">,
): string {
  const bundledDir = join(paths.runtimeDir, "font-matching-crossscript-proxy");
  if (
    CROSS_SCRIPT_PROXY_RUNTIME_FILES.every((fileName) =>
      existsSync(join(bundledDir, fileName)),
    )
  ) {
    return bundledDir;
  }
  return join(
    paths.dataRoot,
    "models",
    "font-matching-crossscript-proxy",
    CROSS_SCRIPT_PROXY_RUNTIME_VERSION,
  );
}
