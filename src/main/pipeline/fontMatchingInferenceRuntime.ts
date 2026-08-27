import { availableParallelism } from "node:os";
import * as onnxRuntimeWeb from "onnxruntime-web";
import {
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
  ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
  ONNXRUNTIME_WEB_VERSION,
} from "../bubbleLayout/constants";
import { onnxRuntimeNode } from "../runtimeSupport/nativeOnnxRuntime";

export {
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
  ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
  ONNXRUNTIME_WEB_VERSION,
  onnxRuntimeNode,
  onnxRuntimeWeb,
};
export type FontMatchingWasmSessionOptions =
  onnxRuntimeWeb.InferenceSession.SessionOptions;

export function resolveFontMatchingWasmThreads(
  env: NodeJS.ProcessEnv = process.env,
  logicalProcessors = availableParallelism(),
): number {
  const configured = Number(env.MANGA_TRANSLATOR_FONT_MATCHING_THREADS);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 8) {
    return configured;
  }
  // Font inference runs in a dedicated worker, so parallelize the large image
  // encoder without claiming the whole machine. Keep at least half the logical
  // processors available while allowing the measured eight-thread fast path.
  return Math.max(1, Math.min(8, Math.floor(logicalProcessors / 2)));
}
