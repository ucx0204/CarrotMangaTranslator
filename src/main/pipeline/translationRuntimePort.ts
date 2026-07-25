import type { TranslationOptions } from "../appSettings";
import { tMain } from "./localization";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  OverlayItem,
  RuntimeModules,
  TranslationResult,
} from "./types";
import { startModelEndpointSession } from "./runtimeModules";
import type { OcrGroupingEvidencePort } from "./ocrGroupingEvidencePort";

type TranslationEndpointSession = {
  readonly handle: ModelEndpointHandle;
  dispose: () => Promise<void>;
};

export type TranslationRuntimePort = {
  isModelCached: (options: TranslationOptions) => boolean;
  startEndpointSession: (
    options: TranslationOptions,
  ) => Promise<TranslationEndpointSession>;
  collectOcrHints: (options: TranslationOptions) => Promise<OcrBboxResult>;
  collectOcrHintsBatch: (
    options: TranslationOptions[],
  ) => Promise<OcrBboxResult[]>;
  requestTranslation: (
    endpoint: ModelEndpointHandle,
    options: TranslationOptions,
  ) => Promise<TranslationResult>;
  saveArtifacts: (
    options: TranslationOptions,
    result: TranslationResult,
  ) => Promise<void>;
  parseJsonLenient: (rawText: string) => unknown;
  parseRegionSingleItem: (rawText: string) => unknown;
  normalizeItems: (parsed: unknown) => OverlayItem[];
  normalizeRegionSingleItem: (parsed: unknown) => OverlayItem[];
};

export type GpuMemoryCoordinator = {
  releaseIdleResources: (reason: string) => Promise<boolean>;
};

async function releaseGpuBeforeOcr(
  gpuMemory: GpuMemoryCoordinator,
  optionsList: TranslationOptions[],
): Promise<void> {
  const gpuOptions = optionsList.find(
    (options) => options.ocrDevice === "gpu" && !options.skipOcrBboxHints,
  );
  if (!gpuOptions) {
    return;
  }
  const disposed = await gpuMemory.releaseIdleResources("ocr-gpu-start");
  if (disposed) {
    gpuOptions.onProgress?.({
      phase: "ocr_running",
      progressText: tMain("ocr.gpuCacheReleased"),
      detail: tMain("ocr.gpuCacheReleasedDetail"),
      progressMode: "log-only",
    });
  }
}

async function releaseInpaintingBeforeGemma(
  gpuMemory: GpuMemoryCoordinator,
  options: TranslationOptions,
): Promise<void> {
  if (options.modelProvider !== "gemma") {
    return;
  }
  const disposed = await gpuMemory.releaseIdleResources("gemma-start");
  if (disposed) {
    options.onProgress?.({
      phase: "booting",
      progressText: "Gemma용 통합 메모리 확보",
      detail:
        "캐시된 인페인팅 모델을 내려 Gemma와 대형 모델이 동시에 상주하지 않게 했습니다.",
      progressMode: "log-only",
    });
  }
}

export function createTranslationRuntimePort({
  gpuMemory,
  groupingEvidence,
  runtime,
}: {
  gpuMemory: GpuMemoryCoordinator;
  groupingEvidence: OcrGroupingEvidencePort;
  runtime: RuntimeModules;
}): TranslationRuntimePort {
  return {
    isModelCached: (options) => runtime.simplePage.isModelCached(options),
    startEndpointSession: async (options) => {
      await groupingEvidence.releaseIdleResources("translation-model-start");
      await releaseInpaintingBeforeGemma(gpuMemory, options);
      return startModelEndpointSession(runtime, options);
    },
    collectOcrHints: async (options) => {
      await releaseGpuBeforeOcr(gpuMemory, [options]);
      const result = await runtime.simplePage.collectOcrBboxHints(options);
      return groupingEvidence.annotate(options, result);
    },
    collectOcrHintsBatch: async (optionsList) => {
      await releaseGpuBeforeOcr(gpuMemory, optionsList);
      if (runtime.simplePage.collectOcrBboxHintsBatch) {
        const results =
          await runtime.simplePage.collectOcrBboxHintsBatch(optionsList);
        return groupingEvidence.annotateBatch(optionsList, results);
      }
      const results: OcrBboxResult[] = [];
      for (const options of optionsList) {
        results.push(await runtime.simplePage.collectOcrBboxHints(options));
      }
      return groupingEvidence.annotateBatch(optionsList, results);
    },
    requestTranslation: (endpoint, options) =>
      runtime.simplePage.requestTranslation(endpoint, options),
    saveArtifacts: (options, result) =>
      runtime.simplePage.saveArtifacts(options, result),
    parseJsonLenient: (rawText) =>
      runtime.overlayTools.parseJsonLenient(rawText),
    parseRegionSingleItem: (rawText) =>
      runtime.overlayTools.parseRegionSingleItem(rawText),
    normalizeItems: (parsed) => runtime.overlayTools.normalizeItems(parsed),
    normalizeRegionSingleItem: (parsed) =>
      runtime.overlayTools.normalizeRegionSingleItem(parsed),
  };
}
