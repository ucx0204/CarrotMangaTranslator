import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import { detectBestGpuInfo } from "../gpuInfo";
import { tMain } from "./localization";
import type {
  InpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import type {
  InpaintingEngine,
  InpaintingRuntimeProgress,
} from "./inpaintingEngine";
import {
  prepareKoharuInpaintingEngine,
  type KoharuInpaintingEngine,
} from "./koharuEngine";
import {
  logInpaintingRuntimeError,
  logInpaintingRuntimeInfo,
  logInpaintingRuntimeWarn,
} from "./inpaintingRuntimeLogger";
import { LeasedIdleResourcePool } from "./leasedIdleResource";

const KOHARU_ENGINE_IDLE_TTL_MS = 5 * 60 * 1000;

type KoharuEngineLease = {
  engine: InpaintingEngine;
  release: () => void;
};

type ResolvedKoharuBackend = Exclude<KoharuInpaintingBackend, "auto">;

type AcquireKoharuEngineOptions = {
  appPaths: AppPaths;
  model: Exclude<InpaintingModel, "flux-klein">;
  backend: KoharuInpaintingBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
};

type KoharuEnginePaths = {
  cudaRuntimeDir: string;
  runtimeDir: string;
  modelDir: string;
  runRootDir: string;
};

const koharuEnginePool = new LeasedIdleResourcePool<KoharuInpaintingEngine>({
  idleTtlMs: KOHARU_ENGINE_IDLE_TTL_MS,
  isReusable: (engine) => engine.isHealthy?.() !== false,
  dispose: disposeKoharuEngine,
});

export async function acquireKoharuInpaintingEngine(
  options: AcquireKoharuEngineOptions,
): Promise<KoharuEngineLease> {
  const paths = resolveKoharuEnginePaths(options.appPaths, options.model);
  const { cudaRuntimeDir, runtimeDir, modelDir, runRootDir } = paths;
  const candidates = await resolveBackendCandidates(options.backend);
  logKoharuBackendCandidatesResolved(
    options.model,
    options.backend,
    candidates,
  );
  const errors: string[] = [];

  for (const [candidateIndex, backend] of candidates.entries()) {
    const key = `${options.model}\n${backend}\n${runtimeDir}\n${modelDir}\n${runRootDir}\n${cudaRuntimeDir}`;
    try {
      const lease = await koharuEnginePool.acquire(key, () =>
        prepareKoharuEngineCandidate(paths, options, backend),
      );
      if (lease.reused) {
        options.onProgress?.({
          progressText: tMain("inpainting.runtime.koharuReady"),
          detail: tMain("inpainting.runtime.cachedKoharu"),
          progressMode: "log-only",
          installLogLine: tMain("inpainting.runtime.cachedKoharuLog"),
        });
      } else {
        logInpaintingRuntimeInfo("Koharu inpainting engine cached", {
          model: options.model,
          backend,
          ttlMs: KOHARU_ENGINE_IDLE_TTL_MS,
        });
      }
      return {
        engine: lease.resource,
        release: lease.release,
      };
    } catch (error) {
      errors.push(
        `${backend}: ${error instanceof Error ? error.message : String(error)}`,
      );
      logKoharuBackendFailure(
        options.model,
        options.backend,
        backend,
        candidates[candidateIndex + 1] ?? null,
        error,
      );
    }
  }

  throw new Error(
    tMain("inpainting.errors.koharuRuntime", { detail: errors.join("\n") }),
  );
}

async function prepareKoharuEngineCandidate(
  paths: KoharuEnginePaths,
  options: AcquireKoharuEngineOptions,
  backend: ResolvedKoharuBackend,
): Promise<KoharuInpaintingEngine> {
  let engine: KoharuInpaintingEngine | null = null;
  try {
    engine = await prepareKoharuInpaintingEngine({
      ...paths,
      model: options.model,
      backend,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    await smokeTestKoharuEngine(engine, options.signal);
    return engine;
  } catch (error) {
    if (engine) {
      await engine.dispose().catch((disposeError) => {
        logInpaintingRuntimeError("Failed to dispose failed Koharu engine", {
          backend,
          disposeError,
        });
      });
    }
    throw error;
  }
}

function resolveKoharuEnginePaths(
  appPaths: AppPaths,
  model: Exclude<InpaintingModel, "flux-klein">,
): KoharuEnginePaths {
  return {
    cudaRuntimeDir: join(
      appPaths.dataRoot,
      "models",
      "inpainting",
      "mgt-flux-klein-runtime",
    ),
    runtimeDir: join(appPaths.dataRoot, "runtime", "koharu-inpainting"),
    modelDir: join(appPaths.dataRoot, "models", "inpainting", model),
    runRootDir: join(appPaths.dataRoot, "tmp", "runtime", "koharu-inpainting"),
  };
}

export async function disposeCachedKoharuInpaintingEngine(
  reason: string,
): Promise<boolean> {
  return koharuEnginePool.dispose(reason);
}

async function disposeKoharuEngine(
  engine: KoharuInpaintingEngine,
  reason: string,
): Promise<void> {
  try {
    await engine.dispose();
    logInpaintingRuntimeInfo("Koharu inpainting engine disposed", { reason });
  } catch (error) {
    logInpaintingRuntimeError(
      "Failed to dispose cached Koharu inpainting engine",
      {
        reason,
        error,
      },
    );
  }
}

async function resolveBackendCandidates(
  requested: KoharuInpaintingBackend,
): Promise<ResolvedKoharuBackend[]> {
  if (requested === "cpu") {
    return ["cpu"];
  }
  if (requested === "cuda-native") {
    return ["cuda-native", "cpu"];
  }
  if (requested === "zluda-native") {
    return ["zluda-native", "cpu"];
  }

  const gpu = await detectBestGpuInfo();
  if (gpu?.vendor === "amd") {
    return ["zluda-native", "cpu"];
  }
  if (gpu?.vendor === "nvidia") {
    return ["cuda-native", "cpu"];
  }
  return ["cpu"];
}

function logKoharuBackendCandidatesResolved(
  model: Exclude<InpaintingModel, "flux-klein">,
  requestedBackend: KoharuInpaintingBackend,
  candidates: ResolvedKoharuBackend[],
): void {
  logInpaintingRuntimeInfo("Koharu backend candidates resolved", {
    model,
    requestedBackend,
    candidates,
  });
}

function logKoharuBackendFailure(
  model: Exclude<InpaintingModel, "flux-klein">,
  requestedBackend: KoharuInpaintingBackend,
  backend: ResolvedKoharuBackend,
  fallbackBackend: ResolvedKoharuBackend | null,
  error: unknown,
): void {
  logInpaintingRuntimeWarn("Koharu inpainting backend failed", {
    model,
    requestedBackend,
    backend,
    fallbackBackend,
    error,
  });
}

async function smokeTestKoharuEngine(
  engine: KoharuInpaintingEngine,
  signal?: AbortSignal,
): Promise<void> {
  const width = 128;
  const height = 128;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  const mask = new Uint8Array(width * height);
  for (let y = 48; y < 80; y += 1) {
    for (let x = 48; x < 80; x += 1) {
      mask[y * width + x] = 1;
    }
  }
  await engine.inpaint(
    bitmap,
    width,
    height,
    mask,
    [{ x: 32, y: 32, w: 64, h: 64 }],
    {
      signal,
      bubbleMask: new Uint8Array(width * height),
      maxPixels: width * height,
    },
  );
}
