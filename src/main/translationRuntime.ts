import { disposeCachedInpaintingEngines } from "./inpainting/inpaintingEnginePool";
import {
  createTranslationRuntimePort,
  type GpuMemoryCoordinator,
  type TranslationRuntimePort,
} from "./pipeline/translationRuntimePort";
import { loadRuntimeModules } from "./pipeline/runtimeModules";

const gpuMemoryCoordinator: GpuMemoryCoordinator = {
  releaseIdleResources: disposeCachedInpaintingEngines,
};

export function loadTranslationRuntimePort(): TranslationRuntimePort {
  return createTranslationRuntimePort({
    gpuMemory: gpuMemoryCoordinator,
    runtime: loadRuntimeModules(),
  });
}
