import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { getAppPaths } from "../appPaths";
import {
  ONNXRUNTIME_WEB_VERSION,
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
  ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
} from "./constants";
import type { ComicPageDetectionResult } from "./contracts";
import type {
  KoharuWasmAssets,
  KoharuWasmWorkerOutboundMessage,
  SerializedKoharuWasmWorkerError,
} from "./wasmWorkerProtocol";

export type KoharuInferenceBackend = "native" | "wasm-worker";

type PendingInference = {
  imageWidth: number;
  imageHeight: number;
  resolve: (result: ComicPageDetectionResult) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
  signal?: AbortSignal;
};

type KoharuWasmWorkerClientDependencies = Readonly<{
  resolveWorkerScript?: () => string;
  resolveWasmAssets?: () => Promise<KoharuWasmAssets>;
  spawnWorker?: (scriptPath: string) => Worker;
  threadCount?: number;
}>;

let sharedClient: KoharuWasmInferenceWorkerClient | null = null;
let verifiedAssetsEntry: Readonly<{
  runtimeDir: string;
  promise: Promise<KoharuWasmAssets>;
}> | null = null;

export function resolveKoharuInferenceBackend(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): KoharuInferenceBackend {
  const override =
    env.MANGA_TRANSLATOR_BUBBLE_LAYOUT_BACKEND?.trim().toLowerCase();
  if (override === "native") return "native";
  if (override === "wasm" || override === "wasm-worker") {
    return "wasm-worker";
  }
  return platform === "darwin" ? "wasm-worker" : "native";
}

export function resolveKoharuWasmThreadCount(
  env: NodeJS.ProcessEnv = process.env,
  logicalProcessors = availableParallelism(),
): number {
  const configured = Number(env.MANGA_TRANSLATOR_BUBBLE_LAYOUT_THREADS);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 8) {
    return configured;
  }
  return Math.max(1, Math.min(4, Math.floor(logicalProcessors / 2)));
}

export async function runKoharuWasmInference(options: {
  modelPath: string;
  imageWidth: number;
  imageHeight: number;
  rgbChw: Float32Array;
  signal?: AbortSignal;
}): Promise<ComicPageDetectionResult> {
  sharedClient ??= new KoharuWasmInferenceWorkerClient();
  return sharedClient.infer(options);
}

export async function disposeKoharuWasmInferenceWorker(): Promise<boolean> {
  const client = sharedClient;
  sharedClient = null;
  return client ? client.dispose() : false;
}

export class KoharuWasmInferenceWorkerClient {
  private worker: Worker | null = null;
  private nextId = 0;
  private disposed = false;
  private readonly pending = new Map<string, PendingInference>();

  constructor(
    private readonly dependencies: KoharuWasmWorkerClientDependencies = {},
  ) {}

  async infer(options: {
    modelPath: string;
    imageWidth: number;
    imageHeight: number;
    rgbChw: Float32Array;
    signal?: AbortSignal;
  }): Promise<ComicPageDetectionResult> {
    throwIfAborted(options.signal);
    if (this.disposed) {
      throw new Error("Koharu WASM inference worker has been disposed.");
    }
    const wasmAssets = await (
      this.dependencies.resolveWasmAssets ?? resolveKoharuWasmAssets
    )();
    throwIfAborted(options.signal);
    const worker = this.ensureWorker();
    const id = `koharu-${this.nextId++}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const onAbort = (): void => {
        worker.postMessage({ type: "cancel", id });
        this.settle(id, "reject", new DOMException("Aborted", "AbortError"));
      };
      this.pending.set(id, {
        imageWidth: options.imageWidth,
        imageHeight: options.imageHeight,
        resolve: resolvePromise,
        reject: rejectPromise,
        onAbort,
        signal: options.signal,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        worker.postMessage(
          {
            type: "infer",
            id,
            modelPath: options.modelPath,
            imageWidth: options.imageWidth,
            imageHeight: options.imageHeight,
            rgbChw: options.rgbChw,
            threadCount:
              this.dependencies.threadCount ?? resolveKoharuWasmThreadCount(),
            wasmAssets,
          },
          [options.rgbChw.buffer as ArrayBuffer],
        );
      } catch (error) {
        this.settle(id, "reject", error);
      }
    });
  }

  async dispose(): Promise<boolean> {
    if (this.disposed) return false;
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(new Error("Koharu WASM inference worker was disposed."));
    if (!worker) return false;
    await worker.terminate();
    return true;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const resolveWorkerScript =
      this.dependencies.resolveWorkerScript ??
      (() => require.resolve("./wasmWorker.js"));
    const spawnWorker =
      this.dependencies.spawnWorker ?? ((scriptPath) => new Worker(scriptPath));
    const worker = spawnWorker(resolveWorkerScript());
    this.worker = worker;
    worker.on("message", (message: unknown) => {
      if (this.worker === worker) this.handleMessage(message);
    });
    worker.on("error", (error) => {
      this.handleWorkerFailure(worker, toError(error));
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.handleWorkerFailure(
          worker,
          new Error(`Koharu WASM inference worker exited with code ${code}.`),
        );
      }
    });
    return worker;
  }

  private handleMessage(value: unknown): void {
    if (!isWorkerMessage(value)) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    if (!value.ok) {
      this.settle(
        value.id,
        "reject",
        value.aborted
          ? new DOMException("Aborted", "AbortError")
          : deserializeError(value.error),
      );
      return;
    }
    try {
      assertInferenceResult(value.result, pending);
      this.settle(value.id, "resolve", value.result);
    } catch (error) {
      this.settle(value.id, "reject", error);
    }
  }

  private handleWorkerFailure(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, "reject", error);
    }
  }

  private settle(
    id: string,
    action: "resolve" | "reject",
    value: unknown,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (action === "resolve") {
      pending.resolve(value as ComicPageDetectionResult);
    } else {
      pending.reject(value);
    }
  }
}

export async function resolveKoharuWasmAssets(
  runtimeDir: string = getAppPaths().runtimeDir,
): Promise<KoharuWasmAssets> {
  const resolvedRuntimeDir = resolve(runtimeDir);
  if (verifiedAssetsEntry?.runtimeDir === resolvedRuntimeDir) {
    return verifiedAssetsEntry.promise;
  }
  const promise = resolveVerifiedKoharuWasmAssets(resolvedRuntimeDir).catch(
    (error: unknown) => {
      if (verifiedAssetsEntry?.promise === promise) {
        verifiedAssetsEntry = null;
      }
      throw error;
    },
  );
  verifiedAssetsEntry = { runtimeDir: resolvedRuntimeDir, promise };
  return promise;
}

async function resolveVerifiedKoharuWasmAssets(
  appRuntimeDir: string,
): Promise<KoharuWasmAssets> {
  const runtimeRoot = join(
    appRuntimeDir,
    "onnxruntime-web",
    ONNXRUNTIME_WEB_VERSION,
  );
  const wasmModulePath = await firstVerifiedAsset(
    [
      join(runtimeRoot, ONNXRUNTIME_WEB_WASM_MODULE_FILE),
      safeRequireResolve(`onnxruntime-web/${ONNXRUNTIME_WEB_WASM_MODULE_FILE}`),
    ],
    ONNXRUNTIME_WEB_WASM_MODULE_BYTES,
    ONNXRUNTIME_WEB_WASM_MODULE_SHA256,
  );
  const wasmBinaryPath = await firstVerifiedAsset(
    [
      join(runtimeRoot, ONNXRUNTIME_WEB_WASM_BINARY_FILE),
      safeRequireResolve(`onnxruntime-web/${ONNXRUNTIME_WEB_WASM_BINARY_FILE}`),
    ],
    ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
    ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  );
  if (!wasmModulePath || !wasmBinaryPath) {
    throw new Error("Verified Koharu ONNX WASM assets are unavailable.");
  }
  return { wasmModulePath, wasmBinaryPath };
}

async function firstVerifiedAsset(
  candidates: readonly (string | null)[],
  expectedBytes: number,
  expectedSha256: string,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const [metadata, bytes] = await Promise.all([
        lstat(candidate),
        readFile(candidate),
      ]);
      if (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.size === expectedBytes &&
        createHash("sha256").update(bytes).digest("hex") === expectedSha256
      ) {
        return resolve(candidate);
      }
    } catch (_error) {
      // error-policy-allow: optional sealed asset locations are tried in order.
    }
  }
  return null;
}

function safeRequireResolve(specifier: string): string | null {
  try {
    return require.resolve(specifier);
  } catch (_error) {
    return null;
  }
}

function isWorkerMessage(
  value: unknown,
): value is KoharuWasmWorkerOutboundMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "infer-done" &&
    "id" in value &&
    typeof value.id === "string" &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function assertInferenceResult(
  result: ComicPageDetectionResult,
  expected: Pick<PendingInference, "imageWidth" | "imageHeight">,
): void {
  if (
    result.executionProvider !== "wasm" ||
    result.imageWidth !== expected.imageWidth ||
    result.imageHeight !== expected.imageHeight ||
    !Array.isArray(result.detections)
  ) {
    throw new Error("Koharu WASM worker returned an invalid result.");
  }
}

function deserializeError(serialized: SerializedKoharuWasmWorkerError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
