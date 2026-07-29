export const COMIC_BUBBLE_DETECTOR_REPO =
  "ogkalu/comic-text-and-bubble-detector";
export const COMIC_BUBBLE_DETECTOR_REVISION =
  "16e8a622f91fabc6b5b65c96d32d1183f8843546";
export const COMIC_BUBBLE_DETECTOR_FILE = "detector-v4-s_int8.onnx";
export const COMIC_BUBBLE_DETECTOR_SHA256 =
  "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79";
export const COMIC_BUBBLE_DETECTOR_BYTES = 11_120_765;
export const COMIC_BUBBLE_DETECTOR_INPUT_SIZE = 640;
export const DEFAULT_COMIC_DETECTION_SCORE_THRESHOLD = 0.35;

export const ONNXRUNTIME_WEB_VERSION = "1.27.0";
export const ONNXRUNTIME_WEB_WASM_MODULE_FILE = "ort-wasm-simd-threaded.mjs";
export const ONNXRUNTIME_WEB_WASM_MODULE_SHA256 =
  "0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3";
export const ONNXRUNTIME_WEB_WASM_MODULE_BYTES = 24_180;
export const ONNXRUNTIME_WEB_WASM_BINARY_FILE = "ort-wasm-simd-threaded.wasm";
export const ONNXRUNTIME_WEB_WASM_BINARY_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort-wasm-simd-threaded.wasm";
export const ONNXRUNTIME_WEB_WASM_BINARY_SHA256 =
  "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6";
export const ONNXRUNTIME_WEB_WASM_BINARY_BYTES = 13_479_978;

export const COMIC_DETECTION_LABELS = [
  "bubble",
  "text_bubble",
  "text_free",
] as const;
