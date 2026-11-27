import type { FluxMode } from "../../shared/inpaintingSettingsTypes";
import { basename, dirname, join, resolve } from "node:path";
import { FluxWorker, type FluxWorkerDiagnostics } from "./fluxWorker";
import type { FluxWorkerLaunchSpec } from "./fluxWorkerTypes";
import type { FluxCropStrategy } from "./fluxCropTiling";
import {
  runFluxInpaint,
  type FluxInpaintDiagnostics,
} from "./fluxEngineRunner";
import {
  FLUX_INPAINT_CONTEXT_PX,
  FLUX_INPAINT_STEPS,
  FLUX_LIGHT_MAX_PIXELS,
  FLUX_REDUCED_INPAINT_CONTEXT_PX,
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

function resolveFluxCropStrategy(
  light: boolean,
  backend: FluxWorkerLaunchSpec["backend"],
  sm75Fp16Enabled = false,
): FluxCropStrategy {
  if (light) return "native";
  return backend === "metal-native" ||
    backend === "cpu-native" ||
    sm75Fp16Enabled
    ? "native-tiled"
    : "resize";
}

export function createFluxEngine(
  options: {
    diagnostics?: FluxEngineDiagnostics;
    launch: FluxWorkerLaunchSpec;
    fluxMode?: FluxMode;
    modelPath?: string;
    vaePath?: string;
    sm75Fp16Enabled?: boolean;
    runRootDir: string;
  },
  runtime: FluxEngineRuntime = productionRuntime,
): FluxInpaintingEngine {
  let worker: FluxWorker | null = null;
  const light = options.fluxMode === "light";
  const { backend } = options.launch;
  const { sm75Fp16Enabled } = options;
  const cropStrategy = resolveFluxCropStrategy(light, backend, sm75Fp16Enabled);
  const getWorker = () => {
    if (worker && !worker.isHealthy()) {
      throw new Error(
        "Flux worker is unhealthy; finish native cleanup before retrying the workload.",
      );
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
    backend,
    runRootDir: options.runRootDir,
    isHealthy() {
      return !worker || worker.isHealthy();
    },
    async inpaint(bitmap, width, height, mask, windows, runOptions = {}) {
      const resolvedRunOptions =
        light || backend === "metal-native"
          ? {
              ...runOptions,
              ...(light && {
                maxPixels: Math.min(
                  runOptions.maxPixels ?? FLUX_LIGHT_MAX_PIXELS,
                  FLUX_LIGHT_MAX_PIXELS,
                ),
                steps: FLUX_INPAINT_STEPS.light,
              }),
              contextPx: Math.min(
                runOptions.contextPx ?? FLUX_INPAINT_CONTEXT_PX,
                FLUX_REDUCED_INPAINT_CONTEXT_PX,
              ),
            }
          : runOptions;
      await runtime.runInpaint(
        {
          bitmap,
          getWorker,
          height,
          isolateWindowMasks: light || backend === "metal-native",
          packLightWindows: light,
          cropStrategy,
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
