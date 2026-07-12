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

const KOHARU_ENGINE_IDLE_TTL_MS = 5 * 60 * 1000;

type KoharuEngineLease = {
  engine: InpaintingEngine;
  release: () => void;
};

type ResolvedKoharuBackend = Exclude<KoharuInpaintingBackend, "auto">;

type KoharuEnginePaths = {
  cudaRuntimeDir: string;
  runtimeDir: string;
  modelDir: string;
  runRootDir: string;
};

type CachedKoharuEngine = {
  key: string;
  engine: KoharuInpaintingEngine;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

let cachedEngine: CachedKoharuEngine | null = null;

export async function acquireKoharuInpaintingEngine(options: {
  appPaths: AppPaths;
  model: Exclude<InpaintingModel, "flux-klein">;
  backend: KoharuInpaintingBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<KoharuEngineLease> {
  const { cudaRuntimeDir, runtimeDir, modelDir, runRootDir } =
    resolveKoharuEnginePaths(options.appPaths, options.model);
  const candidates = await resolveBackendCandidates(options.backend);
  logKoharuBackendCandidatesResolved(
    options.model,
    options.backend,
    candidates,
  );
  const errors: string[] = [];

  for (const [candidateIndex, backend] of candidates.entries()) {
    const key = `${options.model}\n${backend}\n${runtimeDir}\n${modelDir}\n${runRootDir}\n${cudaRuntimeDir}`;
    const cached = await tryAcquireCachedKoharuEngine(key, options.onProgress);
    if (cached) {
      return cached;
    }

    await disposeCachedKoharuInpaintingEngine("replace");
    let engine: KoharuInpaintingEngine | null = null;
    try {
      engine = await prepareKoharuInpaintingEngine({
        runtimeDir,
        cudaRuntimeDir,
        modelDir,
        model: options.model,
        backend,
        runRootDir,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      await smokeTestKoharuEngine(engine, options.signal);
      cachedEngine = {
        key,
        engine,
        idleTimer: null,
      };
      logInpaintingRuntimeInfo("Koharu inpainting engine cached", {
        model: options.model,
        backend,
        ttlMs: KOHARU_ENGINE_IDLE_TTL_MS,
      });
      return {
        engine,
        release: scheduleCachedKoharuEngineDispose,
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
      if (engine) {
        await engine.dispose().catch((disposeError) => {
          logInpaintingRuntimeError("Failed to dispose failed Koharu engine", {
            backend,
            disposeError,
          });
        });
      }
    }
  }

  throw new Error(
    tMain("inpainting.errors.koharuRuntime", { detail: errors.join("\n") }),
  );
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
  const current = cachedEngine;
  if (!current) {
    return false;
  }
  cachedEngine = null;
  clearIdleTimer(current);
  try {
    await current.engine.dispose();
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
  return true;
}

async function tryAcquireCachedKoharuEngine(
  key: string,
  onProgress?: (progress: InpaintingRuntimeProgress) => void,
): Promise<KoharuEngineLease | null> {
  if (cachedEngine?.key !== key) {
    return null;
  }
  if (cachedEngine.engine.isHealthy?.() === false) {
    await disposeCachedKoharuInpaintingEngine("unhealthy-worker");
    return null;
  }
  clearIdleTimer(cachedEngine);
  onProgress?.({
    progressText: tMain("inpainting.runtime.koharuReady"),
    detail: tMain("inpainting.runtime.cachedKoharu"),
    progressMode: "log-only",
    installLogLine: tMain("inpainting.runtime.cachedKoharuLog"),
  });
  return {
    engine: cachedEngine.engine,
    release: scheduleCachedKoharuEngineDispose,
  };
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

function scheduleCachedKoharuEngineDispose(): void {
  if (!cachedEngine) {
    return;
  }
  clearIdleTimer(cachedEngine);
  cachedEngine.idleTimer = setTimeout(() => {
    void disposeCachedKoharuInpaintingEngine("idle-ttl");
  }, KOHARU_ENGINE_IDLE_TTL_MS);
}

function clearIdleTimer(engine: CachedKoharuEngine): void {
  if (engine.idleTimer) {
    clearTimeout(engine.idleTimer);
    engine.idleTimer = null;
  }
}
