import { disposeCachedInpaintingEngines } from "./inpainting/inpaintingEnginePool";
import {
  createTranslationRuntimePort,
  type GpuMemoryCoordinator,
  type TranslationRuntimePort,
} from "./pipeline/translationRuntimePort";
import { loadRuntimeModules } from "./pipeline/runtimeModules";
import type { RuntimeModules } from "./pipeline/types";
import { getAppPaths } from "./appPaths";
import { createAnimeTextEvidencePort } from "./textDetection/animeTextEvidence";
import type { OcrGroupingEvidencePort } from "./pipeline/ocrGroupingEvidencePort";

const gpuMemoryCoordinator: GpuMemoryCoordinator = {
  releaseIdleResources: disposeCachedInpaintingEngines,
};

type TranslationRuntimeResources = {
  runtime: RuntimeModules;
  groupingEvidence: OcrGroupingEvidencePort;
};

let runtimeResources: TranslationRuntimeResources | null = null;

function getTranslationRuntimeResources(): TranslationRuntimeResources {
  if (runtimeResources) {
    return runtimeResources;
  }
  const runtime = loadRuntimeModules();
  const groupingEvidence = createAnimeTextEvidencePort({
    dataRoot: getAppPaths().dataRoot,
    hasPotentialRelation:
      runtime.animeTextRelations.hasPotentialAnimeTextRelation,
    qualifyRelationRegionIds:
      runtime.animeTextRelations.qualifyAnimeTextRelationRegionIds,
  });
  runtimeResources = { runtime, groupingEvidence };
  return runtimeResources;
}

export function loadTranslationRuntimePort(): TranslationRuntimePort {
  const { groupingEvidence, runtime } = getTranslationRuntimeResources();
  return createTranslationRuntimePort({
    gpuMemory: gpuMemoryCoordinator,
    groupingEvidence,
    runtime,
  });
}

export function disposeTranslationRuntimeResources(
  reason: string,
): Promise<boolean> {
  return (
    runtimeResources?.groupingEvidence.releaseIdleResources(reason) ??
    Promise.resolve(false)
  );
}
