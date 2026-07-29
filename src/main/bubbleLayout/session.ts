import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";

const sessionCache = new Map<string, Promise<ort.InferenceSession>>();
let configuredWasmPaths: ResolvedWasmPaths | null = null;

type ResolvedWasmPaths = {
  mjs: string;
  wasm: string;
};

export async function getComicBubbleDetectorSession(options: {
  modelPath: string;
  wasmBinaryPath: string;
  wasmModulePath: string;
  signal?: AbortSignal;
}): Promise<ort.InferenceSession> {
  throwIfAborted(options.signal);
  const modelPath = resolve(options.modelPath);
  const wasmPaths = resolveWasmPaths(options);
  configureWasmRuntime(wasmPaths);
  const cacheKey = buildSessionCacheKey(modelPath, wasmPaths);
  let pending = sessionCache.get(cacheKey);
  if (!pending) {
    pending = createCachedSession(modelPath, cacheKey);
    sessionCache.set(cacheKey, pending);
  }
  const session = await pending;
  throwIfAborted(options.signal);
  return session;
}

function createCachedSession(
  modelPath: string,
  cacheKey: string,
): Promise<ort.InferenceSession> {
  const pending = ort.InferenceSession.create(modelPath, {
    executionProviders: ["wasm"],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    freeDimensionOverrides: { N: 1 },
  })
    .then((session) => {
      assertSessionContract(session);
      return session;
    })
    .catch((error: unknown) => {
      if (sessionCache.get(cacheKey) === pending) {
        sessionCache.delete(cacheKey);
      }
      throw error;
    });
  return pending;
}

function configureWasmRuntime(wasmPaths: ResolvedWasmPaths): void {
  if (configuredWasmPaths) {
    if (
      configuredWasmPaths.mjs !== wasmPaths.mjs ||
      configuredWasmPaths.wasm !== wasmPaths.wasm
    ) {
      throw new Error(
        [
          "말풍선 검출기 ONNX 런타임 경로를 다시 설정할 수 없습니다.",
          `configured=${configuredWasmPaths.mjs},${configuredWasmPaths.wasm}`,
          `requested=${wasmPaths.mjs},${wasmPaths.wasm}`,
        ].join(" "),
      );
    }
    return;
  }
  // A single WASM thread avoids Electron/worker bootstrap constraints while
  // keeping inference deterministic and lightweight.
  ort.env.wasm.wasmPaths = wasmPaths;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  configuredWasmPaths = wasmPaths;
}

function resolveWasmPaths(options: {
  wasmBinaryPath: string;
  wasmModulePath: string;
}): ResolvedWasmPaths {
  return {
    mjs: pathToFileURL(resolve(options.wasmModulePath)).href,
    wasm: pathToFileURL(resolve(options.wasmBinaryPath)).href,
  };
}

function buildSessionCacheKey(
  modelPath: string,
  wasmPaths: ResolvedWasmPaths,
): string {
  return JSON.stringify([modelPath, wasmPaths.mjs, wasmPaths.wasm]);
}

function assertSessionContract(session: ort.InferenceSession): void {
  assertNames(session.inputNames, ["images", "orig_target_sizes"], "입력");
  assertNames(session.outputNames, ["labels", "boxes", "scores"], "출력");
}

function assertNames(
  actual: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const missing = required.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `말풍선 검출기 ONNX ${label} 이름이 올바르지 않습니다: ${missing.join(", ")}`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
