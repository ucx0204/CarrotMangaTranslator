import { basename, dirname, join, resolve } from "node:path";
import { safeCleanup } from "../safeCleanup";
import type { PixelRect } from "./maskGeometry";
import { FluxWorker, type FluxWorkerLaunchSpec } from "./fluxWorker";
import { runFluxInpaint } from "./fluxEngineRunner";
export {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";
export {
  isMaskedRegionEffectivelyUnchanged,
  measureMaskedRegionChange,
  type MaskedRegionChangeStats,
} from "./fluxChangeStats";

export type InpaintingRuntimeProgress = {
  progressText: string;
  detail?: string;
  progressMode?: "determinate" | "indeterminate" | "log-only";
  progressPercent?: number;
  progressBytes?: number;
  progressTotalBytes?: number;
  installLogLine?: string;
};

export type FluxInpaintingEngine = {
  runtimePath: string;
  modelPath?: string;
  vaePath?: string;
  backend: string;
  runRootDir: string;
  isHealthy?: () => boolean;
  inpaint: (
    bitmap: Buffer,
    width: number,
    height: number,
    mask: Uint8Array,
    windows: PixelRect[],
    options?: {
      signal?: AbortSignal;
      featherPx?: number;
      contextPx?: number;
      maskPaddingPx?: number;
      maxPixels?: number;
    },
  ) => Promise<void>;
  dispose: () => Promise<void>;
};

export function createFluxEngine(options: {
  launch: FluxWorkerLaunchSpec;
  modelPath?: string;
  vaePath?: string;
  runRootDir: string;
}): FluxInpaintingEngine {
  let worker: FluxWorker | null = null;
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      void safeCleanup("dispose unhealthy Flux worker", () =>
        worker?.dispose(),
      );
      worker = null;
    }
    worker ??= new FluxWorker(options.launch);
    return worker;
  };
  return {
    runtimePath: options.launch.runtimePath,
    modelPath: options.modelPath,
    vaePath: options.vaePath,
    backend: options.launch.backend,
    runRootDir: options.runRootDir,
    isHealthy() {
      return !worker || worker.isHealthy();
    },
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      await runFluxInpaint({
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

export function resolveDefaultFluxRunRootDir(runtimeDir: string): string {
  const resolvedRuntimeDir = resolve(runtimeDir);
  const inpaintingDir = dirname(resolvedRuntimeDir);
  const modelsDir = dirname(inpaintingDir);
  if (
    basename(inpaintingDir).toLowerCase() === "inpainting" &&
    basename(modelsDir).toLowerCase() === "models"
  ) {
    return join(dirname(modelsDir), "tmp", "runtime", "flux-inpainting");
  }
  return join(resolvedRuntimeDir, "tmp", "flux-inpainting");
}
