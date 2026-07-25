import { join } from "node:path";
import type { AppPaths } from "../appPaths";
import {
  prepareFluxInpaintingEngine,
  type FluxInpaintingEngine,
  type InpaintingRuntimeProgress,
} from "../inpainting";
import type { FluxBackend } from "../../shared/inpaintingSettingsTypes";
import { detectBestGpuInfo } from "../gpuInfo";
import { tMain } from "./localization";
import { LeasedIdleResourcePool } from "../runtimeSupport/leasedIdleResource";
import {
  logInpaintingRuntimeError,
  logInpaintingRuntimeInfo,
} from "./inpaintingRuntimeLogger";

// Apple Silicon shares RAM between the CPU and GPU. Releasing the worker soon
// after a job prevents Flux from competing with local Gemma for unified memory.
const FLUX_ENGINE_IDLE_TTL_MS = 30 * 1000;

type FluxEngineLease = {
  engine: FluxInpaintingEngine;
  release: () => void;
};

const fluxEnginePool = new LeasedIdleResourcePool<FluxInpaintingEngine>({
  idleTtlMs: FLUX_ENGINE_IDLE_TTL_MS,
  isReusable: (engine) => engine.isHealthy?.() !== false,
  dispose: disposeFluxEngine,
});

export async function acquireFluxInpaintingEngine(options: {
  appPaths: AppPaths;
  fluxBackend?: FluxBackend;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<FluxEngineLease> {
  const runtimeDir = join(
    options.appPaths.dataRoot,
    "models",
    "inpainting",
    "mgt-flux-klein-runtime",
  );
  const modelDir = join(
    options.appPaths.dataRoot,
    "models",
    "inpainting",
    "flux-klein-4b",
  );
  const runRootDir = join(
    options.appPaths.dataRoot,
    "tmp",
    "runtime",
    "flux-inpainting",
  );
  const fluxBackend =
    options.fluxBackend ??
    (process.platform === "darwin" ? "metal-native" : "cuda-native");
  const nvidiaComputeCapability =
    fluxBackend === "cuda-native"
      ? await detectNvidiaComputeCapability()
      : null;
  const key = `${fluxBackend}\n${nvidiaComputeCapability ?? "generic"}\n${runtimeDir}\n${modelDir}\n${runRootDir}`;

  const lease = await fluxEnginePool.acquire(key, () =>
    prepareFluxInpaintingEngine({
      runtimeDir,
      modelDir,
      fluxBackend,
      nvidiaComputeCapability,
      runRootDir,
      signal: options.signal,
      onProgress: options.onProgress,
    }),
  );
  if (lease.reused) {
    options.onProgress?.({
      progressText: tMain("inpainting.runtime.fluxReady"),
      detail: tMain("inpainting.runtime.cachedFlux"),
      progressMode: "log-only",
      installLogLine: tMain("inpainting.runtime.cachedFluxLog"),
    });
  } else {
    logInpaintingRuntimeInfo("Flux inpainting engine cached", {
      ttlMs: FLUX_ENGINE_IDLE_TTL_MS,
    });
  }

  return {
    engine: lease.resource,
    release: lease.release,
  };
}

export async function disposeCachedFluxInpaintingEngine(
  reason: string,
): Promise<boolean> {
  return fluxEnginePool.dispose(reason);
}

async function disposeFluxEngine(
  engine: FluxInpaintingEngine,
  reason: string,
): Promise<void> {
  try {
    await engine.dispose();
    logInpaintingRuntimeInfo("Flux inpainting engine disposed", { reason });
  } catch (error) {
    logInpaintingRuntimeError(
      "Failed to dispose cached Flux inpainting engine",
      {
        reason,
        error,
      },
    );
  }
}

async function detectNvidiaComputeCapability(): Promise<number | null> {
  const gpu = await detectBestGpuInfo();
  return gpu?.vendor === "nvidia" ? (gpu.computeCapability ?? null) : null;
}
