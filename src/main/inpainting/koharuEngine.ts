import { safeCleanup } from "../safeCleanup";
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
  InpaintingModel,
  KoharuInpaintingBackend,
} from "../../shared/inpaintingSettingsTypes";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";

export type KoharuInpaintingEngine = InpaintingEngine & {
  model: Exclude<InpaintingModel, "flux-klein">;
};

export async function prepareKoharuInpaintingEngine(options: {
  runtimeDir: string;
  cudaRuntimeDir?: string;
  modelDir: string;
  model: Exclude<InpaintingModel, "flux-klein">;
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
  model: Exclude<InpaintingModel, "flux-klein">;
  modelFiles: KoharuModelFiles;
  runRootDir: string;
}): KoharuInpaintingEngine {
  let worker: KoharuWorker | null = null;
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      void safeCleanup("dispose unhealthy Koharu worker", () =>
        worker?.dispose(),
      );
      worker = null;
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
        runOptions,
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
