/**
 * macOS-safe KoharuLayout inference worker.
 *
 * Native onnxruntime-node session creation can terminate an Electron process
 * before JavaScript can observe an exception on Apple Silicon. Keep the image
 * decode in the main process, then run the pinned ORT-Web WASM backend here so
 * a bubble-layout request cannot take down the Electron main process.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import { KOHARU_LAYOUT_INPUT_SIZE } from "./constants";
import { parseKoharuLayoutOutputs } from "./outputs";
import type {
  KoharuWasmAssets,
  KoharuWasmWorkerInboundMessage,
  KoharuWasmWorkerInferMessage,
  KoharuWasmWorkerOutboundMessage,
  SerializedKoharuWasmWorkerError,
} from "./wasmWorkerProtocol";

const port = parentPort;
if (!port) {
  throw new Error("Koharu WASM worker requires a worker_threads parent port.");
}

type SessionEntry = Readonly<{
  key: string;
  session: ort.InferenceSession;
}>;

let sessionEntry: Promise<SessionEntry> | null = null;
let configuredWasmKey: string | null = null;
let inferenceTail: Promise<void> = Promise.resolve();
const cancelledRequestIds = new Set<string>();
const activeRunOptions = new Map<string, ort.InferenceSession.RunOptions>();

port.on("message", (message: KoharuWasmWorkerInboundMessage) => {
  if (message.type === "cancel") {
    cancelledRequestIds.add(message.id);
    const runOptions = activeRunOptions.get(message.id);
    if (runOptions) runOptions.terminate = true;
    return;
  }
  inferenceTail = inferenceTail.then(() => handleInfer(message));
});

async function handleInfer(
  message: KoharuWasmWorkerInferMessage,
): Promise<void> {
  let input: ort.TypedTensor<"float32"> | null = null;
  let outputs: ort.InferenceSession.ReturnType | null = null;
  const runOptions: ort.InferenceSession.RunOptions = { terminate: false };
  try {
    throwIfCancelled(message.id);
    assertInput(message.rgbChw);
    const session = await getOrCreateSession(message);
    throwIfCancelled(message.id);
    input = new ort.Tensor("float32", message.rgbChw, [
      1,
      3,
      KOHARU_LAYOUT_INPUT_SIZE,
      KOHARU_LAYOUT_INPUT_SIZE,
    ]);
    activeRunOptions.set(message.id, runOptions);
    outputs = await session.run(
      { input },
      ["dets", "labels", "masks"],
      runOptions,
    );
    throwIfCancelled(message.id);
    const detections = parseKoharuLayoutOutputs(outputs, {
      width: message.imageWidth,
      height: message.imageHeight,
    });
    const result = {
      imageWidth: message.imageWidth,
      imageHeight: message.imageHeight,
      detections,
      executionProvider: "wasm" as const,
    };
    post(
      { type: "infer-done", id: message.id, ok: true, result },
      detections.flatMap((detection) =>
        detection.mask ? [detection.mask.logits.buffer as ArrayBuffer] : [],
      ),
    );
  } catch (error) {
    const aborted = cancelledRequestIds.has(message.id);
    post({
      type: "infer-done",
      id: message.id,
      ok: false,
      aborted,
      error: serializeError(error),
    });
  } finally {
    activeRunOptions.delete(message.id);
    cancelledRequestIds.delete(message.id);
    input?.dispose();
    if (outputs) {
      for (const output of Object.values(outputs)) output.dispose?.();
    }
  }
}

async function getOrCreateSession(
  message: KoharuWasmWorkerInferMessage,
): Promise<ort.InferenceSession> {
  const modelPath = resolve(message.modelPath);
  const wasmKey = configureWasmRuntime(message.wasmAssets, message.threadCount);
  const key = JSON.stringify([modelPath, wasmKey]);
  if (!sessionEntry) {
    sessionEntry = createSession(modelPath, key).catch((error: unknown) => {
      sessionEntry = null;
      throw error;
    });
  }
  const entry = await sessionEntry;
  if (entry.key !== key) {
    await entry.session.release();
    sessionEntry = createSession(modelPath, key);
    return (await sessionEntry).session;
  }
  return entry.session;
}

async function createSession(
  modelPath: string,
  key: string,
): Promise<SessionEntry> {
  const model = await readFile(modelPath);
  const session = await ort.InferenceSession.create(
    new Uint8Array(model.buffer, model.byteOffset, model.byteLength),
    {
      executionProviders: ["wasm"],
      executionMode: "sequential",
      graphOptimizationLevel: "all",
    },
  );
  assertNames(session.inputNames, ["input"], "input");
  assertNames(session.outputNames, ["dets", "labels", "masks"], "output");
  return { key, session };
}

function configureWasmRuntime(
  assets: KoharuWasmAssets,
  threadCount: number,
): string {
  const resolved = {
    wasmBinaryPath: resolve(assets.wasmBinaryPath),
    wasmModulePath: resolve(assets.wasmModulePath),
  };
  const key = JSON.stringify([resolved, threadCount]);
  if (configuredWasmKey && configuredWasmKey !== key) {
    throw new Error("Koharu WASM runtime configuration changed after startup.");
  }
  ort.env.wasm.wasmPaths = {
    mjs: pathToFileURL(resolved.wasmModulePath).href,
    wasm: pathToFileURL(resolved.wasmBinaryPath).href,
  };
  ort.env.wasm.numThreads = threadCount;
  ort.env.wasm.proxy = false;
  configuredWasmKey = key;
  return key;
}

function assertInput(rgbChw: Float32Array): void {
  const expected = 3 * KOHARU_LAYOUT_INPUT_SIZE * KOHARU_LAYOUT_INPUT_SIZE;
  if (!(rgbChw instanceof Float32Array) || rgbChw.length !== expected) {
    throw new Error(`Koharu WASM input length is invalid: ${rgbChw.length}`);
  }
}

function assertNames(
  actual: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const missing = required.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Koharu WASM ${label} names are invalid: ${missing.join(", ")}`,
    );
  }
}

function throwIfCancelled(id: string): void {
  if (cancelledRequestIds.has(id)) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function post(
  message: KoharuWasmWorkerOutboundMessage,
  transferList: ArrayBuffer[] = [],
): void {
  port?.postMessage(message, transferList);
}

function serializeError(error: unknown): SerializedKoharuWasmWorkerError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}
