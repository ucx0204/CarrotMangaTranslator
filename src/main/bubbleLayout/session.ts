import { resolve } from "node:path";
import * as ort from "onnxruntime-web";

const sessionCache = new Map<string, Promise<ort.InferenceSession>>();
let wasmConfigured = false;

export async function getComicBubbleDetectorSession(
  modelPath: string,
  signal?: AbortSignal,
): Promise<ort.InferenceSession> {
  throwIfAborted(signal);
  const cacheKey = resolve(modelPath);
  let pending = sessionCache.get(cacheKey);
  if (!pending) {
    pending = createCachedSession(cacheKey);
    sessionCache.set(cacheKey, pending);
  }
  const session = await pending;
  throwIfAborted(signal);
  return session;
}

export async function clearComicBubbleDetectorSessionCache(): Promise<void> {
  const pending = [...sessionCache.values()];
  sessionCache.clear();
  await Promise.allSettled(
    pending.map(async (sessionPromise) => {
      const session = await sessionPromise;
      await session.release();
    }),
  );
}

function createCachedSession(modelPath: string): Promise<ort.InferenceSession> {
  configureWasmRuntime();
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
      if (sessionCache.get(modelPath) === pending) {
        sessionCache.delete(modelPath);
      }
      throw error;
    });
  return pending;
}

function configureWasmRuntime(): void {
  if (wasmConfigured) return;
  // A single WASM thread avoids Electron/worker bootstrap constraints while
  // keeping inference deterministic and lightweight.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  wasmConfigured = true;
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
