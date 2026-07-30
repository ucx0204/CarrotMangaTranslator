import { execFile } from "node:child_process";
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
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";

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
  computeGpuIndex?: number;
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
  const computeGpuIndex = normalizeComputeGpuIndex(options.computeGpuIndex);
  const nvidiaComputeCapability =
    fluxBackend === "cuda-native"
      ? await detectNvidiaComputeCapability(computeGpuIndex)
      : null;
  const key = `${fluxBackend}\n${computeGpuIndex ?? "auto"}\n${nvidiaComputeCapability ?? "generic"}\n${runtimeDir}\n${modelDir}\n${runRootDir}`;

  const lease = await fluxEnginePool.acquire(key, () =>
    prepareFluxInpaintingEngine({
      runtimeDir,
      modelDir,
      fluxBackend,
      computeGpuIndex,
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

export async function detectNvidiaComputeCapability(
  computeGpuIndex?: number,
  querySelectedGpu: (
    index: number,
  ) => Promise<string> = querySelectedNvidiaComputeCapability,
): Promise<number | null> {
  if (computeGpuIndex !== undefined) {
    try {
      return parseNvidiaComputeCapability(
        await querySelectedGpu(computeGpuIndex),
      );
    } catch (_error) {
      return null;
    }
  }
  const gpu = await detectBestGpuInfo();
  return gpu?.vendor === "nvidia" ? (gpu.computeCapability ?? null) : null;
}

function querySelectedNvidiaComputeCapability(index: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "nvidia-smi",
      [
        `--id=${index}`,
        "--query-gpu=compute_cap",
        "--format=csv,noheader,nounits",
      ],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function parseNvidiaComputeCapability(value: string): number | null {
  const parsed = Number(value.trim().split(/\r?\n/, 1)[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
