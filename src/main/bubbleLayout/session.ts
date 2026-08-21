import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import type * as Ort from "onnxruntime-node";
import { onnxRuntimeNode as ort } from "./nativeOrt";

export type KoharuExecutionProvider = "dml" | "cpu";

export type KoharuLayoutSessionHandle = {
  session: Ort.InferenceSession;
  provider: KoharuExecutionProvider;
};

const sessionCache = new Map<string, Promise<Ort.InferenceSession>>();
const unavailableProviderKeys = new Set<string>();
const sessionRunTails = new WeakMap<Ort.InferenceSession, Promise<void>>();

export async function getKoharuLayoutSession(options: {
  modelPath: string;
  signal?: AbortSignal;
  providerPreference?: readonly KoharuExecutionProvider[];
}): Promise<KoharuLayoutSessionHandle> {
  throwIfAborted(options.signal);
  const modelPath = resolve(options.modelPath);
  const providers =
    options.providerPreference ?? resolveKoharuProviderPreference();
  const errors: unknown[] = [];
  for (const provider of providers) {
    const cacheKey = JSON.stringify([modelPath, provider]);
    if (unavailableProviderKeys.has(cacheKey)) continue;
    try {
      const session = await getOrCreateSession(modelPath, provider, cacheKey);
      throwIfAborted(options.signal);
      return { session, provider };
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(options.signal);
      unavailableProviderKeys.add(cacheKey);
      errors.push(error);
    }
  }
  throw new AggregateError(
    errors,
    "KoharuLayout ONNX 세션을 DML 또는 CPU로 만들 수 없습니다.",
  );
}

export function resolveKoharuProviderPreference(
  platform: NodeJS.Platform = process.platform,
): readonly KoharuExecutionProvider[] {
  return platform === "win32" ? ["dml", "cpu"] : ["cpu"];
}

export function resolveKoharuCpuThreadCount(): number {
  return Math.max(1, Math.min(8, availableParallelism()));
}

/**
 * DirectML forbids concurrent Run calls on one session. Use the same lease for
 * CPU sessions so provider fallback cannot change job ordering.
 */
export async function withKoharuSessionLease<T>(
  session: Ort.InferenceSession,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const previous = sessionRunTails.get(session) ?? Promise.resolve();
  let releaseLease: () => void = () => undefined;
  const lease = new Promise<void>((resolveLease) => {
    releaseLease = resolveLease;
  });
  const tail = previous.catch(() => undefined).then(() => lease);
  sessionRunTails.set(session, tail);
  try {
    await previous.catch(() => undefined);
    throwIfAborted(signal);
    return await task();
  } finally {
    releaseLease();
    if (sessionRunTails.get(session) === tail) {
      sessionRunTails.delete(session);
    }
  }
}

function getOrCreateSession(
  modelPath: string,
  provider: KoharuExecutionProvider,
  cacheKey: string,
): Promise<Ort.InferenceSession> {
  let pending = sessionCache.get(cacheKey);
  if (!pending) {
    pending = createCachedSession(modelPath, provider, cacheKey);
    sessionCache.set(cacheKey, pending);
  }
  return pending;
}

function createCachedSession(
  modelPath: string,
  provider: KoharuExecutionProvider,
  cacheKey: string,
): Promise<Ort.InferenceSession> {
  const pending = ort.InferenceSession.create(modelPath, {
    executionProviders: [provider],
    executionMode: "sequential",
    graphOptimizationLevel: "all",
    intraOpNumThreads: provider === "cpu" ? resolveKoharuCpuThreadCount() : 1,
    interOpNumThreads: 1,
    enableMemPattern: provider === "cpu",
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

function assertSessionContract(session: Ort.InferenceSession): void {
  assertNames(session.inputNames, ["input"], "입력");
  assertNames(session.outputNames, ["dets", "labels", "masks"], "출력");
}

function assertNames(
  actual: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const missing = required.filter((name) => !actual.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `KoharuLayout ONNX ${label} 이름이 올바르지 않습니다: ${missing.join(", ")}`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
