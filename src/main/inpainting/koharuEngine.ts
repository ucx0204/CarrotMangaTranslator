import type {
  InpaintingEngine,
  InpaintingRuntimeProgress,
} from "./inpaintingEngine";
import type { KoharuWorkerLaunchSpec } from "./koharuWorkerTypes";
import { KoharuWorker } from "./koharuWorker";
import { runKoharuInpaint } from "./koharuEngineRunner";
import type { KoharuModelFiles } from "./koharuAssets";
import {
  ensureKoharuModelAssets,
  ensureKoharuWorkerLaunch,
} from "./koharuAssets";
import type {
  KoharuInpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";

export type KoharuInpaintingEngine = InpaintingEngine & {
  model: KoharuInpaintingModel;
};

/**
 * Retain the established 512px Metal memory budget during the LibTorch
 * migration. Increasing it requires an Apple Silicon memory/inference check.
 */
export const KOHARU_LAMA_METAL_MAX_PIXELS = 512 * 512;

export function resolveKoharuInpaintMaxPixels(options: {
  backend: KoharuInpaintingBackend;
  model: KoharuInpaintingModel;
  requestedMaxPixels?: number;
}): number | undefined {
  const requestedMaxPixels = normalizeRequestedMaxPixels(
    options.requestedMaxPixels,
  );
  if (options.backend !== "metal-native" || options.model !== "lama-manga") {
    return requestedMaxPixels;
  }
  return Math.min(
    requestedMaxPixels ?? KOHARU_LAMA_METAL_MAX_PIXELS,
    KOHARU_LAMA_METAL_MAX_PIXELS,
  );
}

export async function prepareKoharuInpaintingEngine(options: {
  runtimeDir: string;
  cudaRuntimeDir?: string;
  modelDir: string;
  model: KoharuInpaintingModel;
  backend: KoharuInpaintingBackend;
  computeGpuIndex?: number;
  runRootDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: InpaintingRuntimeProgress) => void;
}): Promise<KoharuInpaintingEngine> {
  const modelFiles = await ensureKoharuModelAssets({
    model: options.model,
    modelDir: options.modelDir,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const launch = await ensureKoharuWorkerLaunch({
    runtimeDir: options.runtimeDir,
    cudaRuntimeDir: options.cudaRuntimeDir,
    model: options.model,
    modelFiles,
    backend: options.backend,
    computeGpuIndex: options.computeGpuIndex,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  launch.computeGpuIndex = normalizeComputeGpuIndex(options.computeGpuIndex);
  return createKoharuEngine({
    launch,
    model: options.model,
    modelFiles,
    runRootDir: options.runRootDir,
  });
}

function createKoharuEngine(options: {
  launch: KoharuWorkerLaunchSpec;
  model: KoharuInpaintingModel;
  modelFiles: KoharuModelFiles;
  runRootDir: string;
}): KoharuInpaintingEngine {
  let worker: KoharuWorker | null = null;
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      throw new Error(
        "Koharu worker is unhealthy; finish native cleanup before retrying the workload.",
      );
    }
    worker ??= new KoharuWorker(options.launch);
    return worker;
  };
  return {
    model: options.model,
    runtimePath: options.launch.runtimePath,
    modelPath: options.modelFiles.weightsPath,
    backend: options.launch.backend,
    runRootDir: options.runRootDir,
    isHealthy() {
      return !worker || worker.isHealthy();
    },
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      await runKoharuInpaint({
        bitmap,
        getWorker,
        height,
        mask,
        runOptions: {
          ...runOptions,
          maxPixels: resolveKoharuInpaintMaxPixels({
            backend: options.launch.backend,
            model: options.model,
            requestedMaxPixels: runOptions.maxPixels,
          }),
        },
        runRootDir: options.runRootDir,
        width,
        windows,
      });
    },
    async dispose() {
      await worker?.dispose();
      worker = null;
    },
  };
}

function normalizeRequestedMaxPixels(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(
      `Koharu maxPixels must be a positive finite number: ${value}`,
    );
  }
  return Math.floor(value);
}
