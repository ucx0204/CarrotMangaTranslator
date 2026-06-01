import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import { logError, logInfo } from "../logger";
import { prepareFluxInpaintingEngine, type FluxInpaintingEngine, type InpaintingRuntimeProgress } from "../inpainting";

const FLUX_ENGINE_IDLE_TTL_MS = 5 * 60 * 1000;

type FluxEngineLease = {
  engine: FluxInpaintingEngine;
  release: () => void;
};

type CachedFluxEngine = {
  key: string;
  engine: FluxInpaintingEngine;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

let cachedEngine: CachedFluxEngine | null = null;

export async function acquireFluxInpaintingEngine(options: {
  appPaths: AppPaths;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<FluxEngineLease> {
  const runtimeDir = join(options.appPaths.dataRoot, "models", "inpainting", "mgt-flux-klein-runtime");
  const modelDir = join(options.appPaths.dataRoot, "models", "inpainting", "flux-klein-4b");
  const key = `${runtimeDir}\n${modelDir}`;

  if (cachedEngine?.key === key) {
    clearIdleTimer(cachedEngine);
    options.onProgress?.({
      progressText: "Flux 인페인팅 준비 완료",
      detail: "캐시된 Flux 엔진 사용",
      progressMode: "log-only",
      installLogLine: "캐시된 Flux 인페인팅 엔진을 재사용합니다."
    });
    return {
      engine: cachedEngine.engine,
      release: scheduleCachedFluxEngineDispose
    };
  }

  await disposeCachedFluxInpaintingEngine("replace");
  const engine = await prepareFluxInpaintingEngine({
    runtimeDir,
    modelDir,
    signal: options.signal,
    onProgress: options.onProgress
  });
  cachedEngine = {
    key,
    engine,
    idleTimer: null
  };
  logInfo("Flux inpainting engine cached", { ttlMs: FLUX_ENGINE_IDLE_TTL_MS });

  return {
    engine,
    release: scheduleCachedFluxEngineDispose
  };
}

export async function disposeCachedFluxInpaintingEngine(reason: string): Promise<boolean> {
  const current = cachedEngine;
  if (!current) {
    return false;
  }
  cachedEngine = null;
  clearIdleTimer(current);
  try {
    await current.engine.dispose();
    logInfo("Flux inpainting engine disposed", { reason });
  } catch (error) {
    logError("Failed to dispose cached Flux inpainting engine", { reason, error });
  }
  return true;
}

function scheduleCachedFluxEngineDispose(): void {
  if (!cachedEngine) {
    return;
  }
  clearIdleTimer(cachedEngine);
  cachedEngine.idleTimer = setTimeout(() => {
    void disposeCachedFluxInpaintingEngine("idle-ttl");
  }, FLUX_ENGINE_IDLE_TTL_MS);
}

function clearIdleTimer(engine: CachedFluxEngine): void {
  if (engine.idleTimer) {
    clearTimeout(engine.idleTimer);
    engine.idleTimer = null;
  }
}
