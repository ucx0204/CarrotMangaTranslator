import { basename, dirname, join, resolve } from "node:path";
import { safeCleanup } from "../safeCleanup";
import { FluxWorker, type FluxWorkerDiagnostics } from "./fluxWorker";
import type { FluxWorkerLaunchSpec } from "./fluxWorkerTypes";
import {
  runFluxInpaint,
  type FluxInpaintDiagnostics,
} from "./fluxEngineRunner";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_METAL_INPAINT_CONTEXT_PX,
} from "./fluxEngineConstants";
import type { InpaintingEngine } from "./inpaintingEngine";

export type FluxInpaintingEngine = InpaintingEngine & {
  model: "flux-klein";
  vaePath?: string;
};

export type FluxEngineRuntime = {
  runInpaint: typeof runFluxInpaint;
};

export type FluxEngineDiagnostics = FluxInpaintDiagnostics &
  FluxWorkerDiagnostics;

const productionRuntime: FluxEngineRuntime = {
  runInpaint: runFluxInpaint,
};

export function createFluxEngine(
  options: {
    diagnostics?: FluxEngineDiagnostics;
    launch: FluxWorkerLaunchSpec;
    modelPath?: string;
    vaePath?: string;
    sm75Fp16Enabled?: boolean;
    runRootDir: string;
  },
  runtime: FluxEngineRuntime = productionRuntime,
): FluxInpaintingEngine {
  let worker: FluxWorker | null = null;
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      void safeCleanup("dispose unhealthy Flux worker", () =>
        worker?.dispose(),
      );
      worker = null;
    }
    worker ??= new FluxWorker(options.launch, {
      diagnostics: options.diagnostics,
    });
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
      await runtime.runInpaint(
        {
          bitmap,
          getWorker,
          height,
          isolateWindowMasks: options.launch.backend === "metal-native",
          tileLargeCrops:
            options.launch.backend === "metal-native" ||
            options.sm75Fp16Enabled === true,
          mask,
          runOptions: resolvedRunOptions,
          runRootDir: options.runRootDir,
          width,
          windows,
        },
        options.diagnostics,
      );
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
