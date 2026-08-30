/**
 * Production page-layout model. This replaces the legacy comic RT-DETR
 * detector completely; there is no legacy-model fallback path.
 */
export const KOHARU_LAYOUT_ONNX_REPO =
  "ShiniShiho/koharu-layout-rfdetr-seg-2xl-1152-onnx";
export const KOHARU_LAYOUT_ONNX_REVISION =
  "bfbbd4e5ab34a50459865074fa044da496cebb57";
export const KOHARU_LAYOUT_ONNX_FILE = "rfdetr-seg-2xlarge.onnx";
export const KOHARU_LAYOUT_ONNX_SHA256 =
  "7cc10d4316371946b8441da3512261a8e148b129abcdb0ea6235ed1d1d06d351";
export const KOHARU_LAYOUT_ONNX_BYTES = 148_442_003;
export const KOHARU_LAYOUT_INPUT_SIZE = 1152;
export const KOHARU_LAYOUT_QUERY_COUNT = 300;
export const KOHARU_LAYOUT_MASK_SIZE = 288;

export const KOHARU_LAYOUT_LABELS = [
  "text",
  "onomatopoeia",
  "bubble",
  "panel",
] as const;

/** Per-class thresholds published with the pinned KoharuLayout model. */
export const KOHARU_LAYOUT_SCORE_THRESHOLDS = [0.25, 0.2, 0.5, 0.5] as const;

/**
 * The font pixel-inference runtime and the macOS-safe bubble detector consume
 * the same sealed ORT-Web assets. Keep the published hashes shared so both
 * runtime paths reject a partial or substituted package.
 */
export const ONNXRUNTIME_WEB_VERSION = "1.27.0";
export const ONNXRUNTIME_WEB_WASM_MODULE_FILE = "ort-wasm-simd-threaded.mjs";
export const ONNXRUNTIME_WEB_WASM_MODULE_SHA256 =
  "0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3";
export const ONNXRUNTIME_WEB_WASM_MODULE_BYTES = 24_180;
export const ONNXRUNTIME_WEB_WASM_BINARY_FILE = "ort-wasm-simd-threaded.wasm";
export const ONNXRUNTIME_WEB_WASM_BINARY_SHA256 =
  "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6";
export const ONNXRUNTIME_WEB_WASM_BINARY_BYTES = 13_479_978;
