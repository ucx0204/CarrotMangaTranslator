import type { ComicPageDetectionResult } from "./contracts";

export type KoharuWasmAssets = Readonly<{
  wasmBinaryPath: string;
  wasmModulePath: string;
}>;

export type KoharuWasmWorkerInferMessage = Readonly<{
  type: "infer";
  id: string;
  imageWidth: number;
  imageHeight: number;
  modelPath: string;
  rgbChw: Float32Array;
  threadCount: number;
  wasmAssets: KoharuWasmAssets;
}>;

export type KoharuWasmWorkerCancelMessage = Readonly<{
  type: "cancel";
  id: string;
}>;

export type KoharuWasmWorkerInboundMessage =
  | KoharuWasmWorkerInferMessage
  | KoharuWasmWorkerCancelMessage;

export type SerializedKoharuWasmWorkerError = Readonly<{
  name: string;
  message: string;
}>;

export type KoharuWasmWorkerSuccessMessage = Readonly<{
  type: "infer-done";
  id: string;
  ok: true;
  result: ComicPageDetectionResult;
}>;

export type KoharuWasmWorkerFailureMessage = Readonly<{
  type: "infer-done";
  id: string;
  ok: false;
  aborted: boolean;
  error: SerializedKoharuWasmWorkerError;
}>;

export type KoharuWasmWorkerOutboundMessage =
  | KoharuWasmWorkerSuccessMessage
  | KoharuWasmWorkerFailureMessage;
