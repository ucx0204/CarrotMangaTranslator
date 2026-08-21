import { join } from "node:path";
import {
  ensureRemoteFile,
  hfResolveUrl,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import {
  KOHARU_LAYOUT_ONNX_BYTES,
  KOHARU_LAYOUT_ONNX_FILE,
  KOHARU_LAYOUT_ONNX_REPO,
  KOHARU_LAYOUT_ONNX_REVISION,
  KOHARU_LAYOUT_ONNX_SHA256,
} from "./constants";

export const KOHARU_LAYOUT_ONNX_URL = hfResolveUrl(
  KOHARU_LAYOUT_ONNX_REPO,
  KOHARU_LAYOUT_ONNX_FILE,
  KOHARU_LAYOUT_ONNX_REVISION,
);

export type KoharuLayoutAssets = {
  modelPath: string;
};

export async function ensureKoharuLayoutAssets(options: {
  dataRoot: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<KoharuLayoutAssets> {
  throwIfAborted(options.signal);
  const modelPath = await ensureRemoteFile({
    modelDir: join(
      options.dataRoot,
      "models",
      "bubble-layout",
      "koharu-layout-rfdetr-seg-2xl-1152",
    ),
    url: KOHARU_LAYOUT_ONNX_URL,
    fileName: KOHARU_LAYOUT_ONNX_FILE,
    label: "KoharuLayout RF-DETR segmentation",
    expectedSha256: KOHARU_LAYOUT_ONNX_SHA256,
    minimumBytes: KOHARU_LAYOUT_ONNX_BYTES,
    expectedTotalBytes: KOHARU_LAYOUT_ONNX_BYTES,
    maximumBytes: KOHARU_LAYOUT_ONNX_BYTES,
    progressPhase: "bubble_layout_preparing",
    signal: options.signal,
    onProgress: options.onProgress,
  });
  throwIfAborted(options.signal);
  return { modelPath };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
