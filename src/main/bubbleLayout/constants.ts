/**
 * Production page-layout model. This replaces the legacy comic RT-DETR
 * detector completely; there is no legacy-model fallback path.
 */
export const KOHARU_LAYOUT_ONNX_REPO = "erdeneetemp/koharu-layout-highres-onnx";
export const KOHARU_LAYOUT_ONNX_REVISION =
  "a5818861f184f496c2e45063c9542ffb7abccd37";
export const KOHARU_LAYOUT_ONNX_FILE = "model.onnx";
export const KOHARU_LAYOUT_ONNX_SHA256 =
  "b2f8807dfd00adc82233f4456e79a32fdc32d658ddb2a7a0182c523c638e52ea";
export const KOHARU_LAYOUT_ONNX_BYTES = 174_648_069;
export const KOHARU_LAYOUT_INPUT_SIZE = 1920;
export const KOHARU_LAYOUT_QUERY_COUNT = 300;
export const KOHARU_LAYOUT_MASK_SIZE = 480;

export const KOHARU_LAYOUT_LABELS = [
  "text",
  "onomatopoeia",
  "bubble",
  "panel",
] as const;

/** Koharu application defaults for HighRes lettering, bubbles and panels. */
export const KOHARU_LAYOUT_SCORE_THRESHOLDS = [0.25, 0.4, 0.4, 0.4] as const;

/**
 * The font pixel-inference runtime and the macOS-safe bubble detector consume
 * the same sealed ORT-Web assets. Keep the published hashes shared so both
 * runtime paths reject a partial or substituted package.
 */
export const ONNXRUNTIME_WEB_VERSION = "1.30.0";
export const ONNXRUNTIME_WEB_WASM_MODULE_FILE = "ort-wasm-simd-threaded.mjs";
export const ONNXRUNTIME_WEB_WASM_MODULE_SHA256 =
  "e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b";
export const ONNXRUNTIME_WEB_WASM_MODULE_BYTES = 24_381;
export const ONNXRUNTIME_WEB_WASM_BINARY_FILE = "ort-wasm-simd-threaded.wasm";
export const ONNXRUNTIME_WEB_WASM_BINARY_SHA256 =
  "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2";
export const ONNXRUNTIME_WEB_WASM_BINARY_BYTES = 14_239_897;
