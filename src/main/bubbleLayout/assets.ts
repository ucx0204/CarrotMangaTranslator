import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ensureRemoteFile,
  hfResolveUrl,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import {
  COMIC_BUBBLE_DETECTOR_BYTES,
  COMIC_BUBBLE_DETECTOR_FILE,
  COMIC_BUBBLE_DETECTOR_REPO,
  COMIC_BUBBLE_DETECTOR_REVISION,
  COMIC_BUBBLE_DETECTOR_SHA256,
  ONNXRUNTIME_WEB_VERSION,
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_BINARY_URL,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
} from "./constants";

export const COMIC_BUBBLE_DETECTOR_URL = hfResolveUrl(
  COMIC_BUBBLE_DETECTOR_REPO,
  COMIC_BUBBLE_DETECTOR_FILE,
  COMIC_BUBBLE_DETECTOR_REVISION,
);

export type ComicBubbleDetectorAssets = {
  modelPath: string;
  wasmBinaryPath: string;
  wasmModulePath: string;
};

export async function ensureComicBubbleDetectorAssets(options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<ComicBubbleDetectorAssets> {
  throwIfAborted(options.signal);
  const wasmModulePath = resolveWasmModulePath();
  const [modelPath, wasmBinaryPath] = await Promise.all([
    ensureRemoteFile({
      modelDir: join(
        options.dataRoot,
        "models",
        "bubble-layout",
        "comic-text-and-bubble-detector",
      ),
      url: COMIC_BUBBLE_DETECTOR_URL,
      fileName: COMIC_BUBBLE_DETECTOR_FILE,
      label: "comic-text-and-bubble-detector",
      expectedSha256: COMIC_BUBBLE_DETECTOR_SHA256,
      minimumBytes: COMIC_BUBBLE_DETECTOR_BYTES,
      progressPhase: "bubble_layout_preparing",
      signal: options.signal,
      onProgress: options.onProgress,
    }),
    ensureRemoteFile({
      modelDir: join(
        options.dataRoot,
        "runtime",
        "onnxruntime-web",
        ONNXRUNTIME_WEB_VERSION,
      ),
      url: ONNXRUNTIME_WEB_WASM_BINARY_URL,
      fileName: ONNXRUNTIME_WEB_WASM_BINARY_FILE,
      label: `onnxruntime-web ${ONNXRUNTIME_WEB_VERSION} wasm`,
      expectedSha256: ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
      minimumBytes: ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
      progressPhase: "bubble_layout_preparing",
      signal: options.signal,
      onProgress: options.onProgress,
    }),
  ]);
  throwIfAborted(options.signal);
  return { modelPath, wasmBinaryPath, wasmModulePath };
}

function resolveWasmModulePath(): string {
  const packagedPath =
    typeof process.resourcesPath === "string" && process.resourcesPath
      ? join(
          process.resourcesPath,
          "app-runtime",
          "onnxruntime-web",
          ONNXRUNTIME_WEB_VERSION,
          ONNXRUNTIME_WEB_WASM_MODULE_FILE,
        )
      : null;
  if (packagedPath && existsSync(packagedPath)) {
    return packagedPath;
  }
  try {
    return require.resolve(
      `onnxruntime-web/${ONNXRUNTIME_WEB_WASM_MODULE_FILE}`,
    );
  } catch (error) {
    throw new Error(
      `onnxruntime-web WASM 모듈을 찾을 수 없습니다: ${
        packagedPath ?? "packaged path unavailable"
      }`,
      { cause: error },
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
