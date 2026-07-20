import { basename, dirname, join, resolve } from "node:path";
import { safeCleanup } from "../safeCleanup";
import { FluxWorker, type FluxWorkerLaunchSpec } from "./fluxWorker";
import { runFluxInpaint } from "./fluxEngineRunner";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_METAL_INPAINT_CONTEXT_PX,
} from "./fluxEngineConstants";
import type {
  InpaintingEngine,
  InpaintingRuntimeProgress,
} from "./inpaintingEngine";
export {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_FEATHER_PX,
  FLUX_INPAINT_MASK_PADDING_PX,
  FLUX_INPAINT_MAX_PIXELS,
} from "./fluxEngineConstants";
export { isMaskedRegionEffectivelyUnchanged } from "./fluxChangeStats";

export type { InpaintingRuntimeProgress };

export type FluxInpaintingEngine = InpaintingEngine & {
  model: "flux-klein";
  vaePath?: string;
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
    model: "flux-klein",
    runtimePath: options.launch.runtimePath,
    modelPath: options.modelPath,
    vaePath: options.vaePath,
    backend: options.launch.backend,
    runRootDir: options.runRootDir,
    isHealthy() {
      return !worker || worker.isHealthy();
    },
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      const resolvedRunOptions =
        options.launch.backend === "metal-native"
          ? {
              ...runOptions,
              contextPx: Math.min(
                runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX,
                FLUX_METAL_INPAINT_CONTEXT_PX,
              ),
            }
          : runOptions;
      await runFluxInpaint({
        bitmap,
        getWorker,
        height,
        isolateWindowMasks: options.launch.backend === "metal-native",
        tileLargeCrops: options.launch.backend === "metal-native",
        mask,
        runOptions: resolvedRunOptions,
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
