import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import {
  ensureRemoteFile,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import {
  CROSS_SCRIPT_PROXY_RUNTIME_FILES,
  CROSS_SCRIPT_PROXY_RUNTIME_VERSION,
} from "./fontMatchingCrossScriptProxyPaths";
import { FONT_MATCHING_RUNTIME_BASE_URL } from "./fontMatchingRuntimeRelease";

type CrossScriptProxyRuntimeFile = Readonly<{
  bytes: number;
  fileName: (typeof CROSS_SCRIPT_PROXY_RUNTIME_FILES)[number];
  sha256: string;
  urlName: string;
}>;

export const CROSS_SCRIPT_PROXY_RUNTIME_ASSETS: readonly CrossScriptProxyRuntimeFile[] =
  [
    {
      fileName: ".owned.json",
      urlName: "font-matching-crossscript-proxy-owned.json",
      bytes: 924,
      sha256:
        "e1df5fa7230b0290456cc0a3e46d4c399074ea72bba751807f69b43b58e36fd4",
    },
    {
      fileName: "runtime-manifest.json",
      urlName: "font-matching-crossscript-proxy-runtime-manifest.json",
      bytes: 14_306,
      sha256:
        "3572cc0f95396250eeacb0c9ba441ff1acebf5c5e84e085b36e86076ab8bc929",
    },
    {
      fileName: "style-encoder.onnx",
      urlName: "font-matching-crossscript-proxy-style-encoder.onnx",
      bytes: 6_111_803,
      sha256:
        "79a76a2fe0e89e05511b47d3f3a975027906c309820a2469bd51321d47dead3f",
    },
    {
      fileName: "glyph-decoder.onnx",
      urlName: "font-matching-crossscript-proxy-glyph-decoder.onnx",
      bytes: 14_236_244,
      sha256:
        "cbd4c66fc1b9f6a907567703c086ad7c5fa1279c53ed6f45b2fece399a4351c6",
    },
    {
      fileName: "candidate-glyphs.u8",
      urlName: "font-matching-crossscript-proxy-candidate-glyphs.u8",
      bytes: 9_068_544,
      sha256:
        "54bd3ab75717e3ee4cf27c7443e1ed06a320f1cbdcd1ebd7afdb80c55cf644d9",
    },
  ];

export async function ensureCrossScriptProxyRuntimeAssets(options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string> {
  const cacheDir = join(
    options.dataRoot,
    "models",
    "font-matching-crossscript-proxy",
    CROSS_SCRIPT_PROXY_RUNTIME_VERSION,
  );
  for (const file of CROSS_SCRIPT_PROXY_RUNTIME_ASSETS) {
    await ensureRemoteFile({
      modelDir: cacheDir,
      url: `${FONT_MATCHING_RUNTIME_BASE_URL}/${file.urlName}`,
      fileName: file.fileName,
      label: `font-matching-crossscript-proxy/${file.fileName}`,
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

export function hasCompleteBundledCrossScriptProxyRuntime(
  paths: Pick<AppPaths, "runtimeDir">,
): boolean {
  const bundledDir = join(paths.runtimeDir, "font-matching-crossscript-proxy");
  return CROSS_SCRIPT_PROXY_RUNTIME_FILES.every((fileName) =>
    existsSync(join(bundledDir, fileName)),
  );
}
