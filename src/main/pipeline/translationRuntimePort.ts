import type { TranslationOptions } from "../appSettings";
import { disposeCachedInpaintingEngines } from "../inpainting/inpaintingEnginePool";
import { tMain } from "./localization";
import type {
  ModelEndpointHandle,
  OcrBboxResult,
  OverlayItem,
  TranslationResult,
} from "./types";
import {
  loadRuntimeModules,
  startModelEndpointSession,
  type ModelEndpointSession,
} from "./runtimeModules";

export type TranslationRuntimePort = {
  isModelCached: (options: TranslationOptions) => boolean;
  startEndpointSession: (
    options: TranslationOptions,
  ) => Promise<ModelEndpointSession>;
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

let cachedPort: TranslationRuntimePort | null = null;

async function releaseGpuBeforeOcr(
  optionsList: TranslationOptions[],
): Promise<void> {
  const gpuOptions = optionsList.find(
    (options) => options.ocrDevice === "gpu" && !options.skipOcrBboxHints,
  );
  if (!gpuOptions) {
    return;
  }
  const disposed = await disposeCachedInpaintingEngines("ocr-gpu-start");
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
  options: TranslationOptions,
): Promise<void> {
  if (options.modelProvider !== "gemma") {
    return;
  }
  const disposed = await disposeCachedInpaintingEngines("gemma-start");
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

export function loadTranslationRuntimePort(): TranslationRuntimePort {
  if (cachedPort) {
    return cachedPort;
  }

  const runtime = loadRuntimeModules();
  const port: TranslationRuntimePort = {
    isModelCached: (options) => runtime.simplePage.isModelCached(options),
    startEndpointSession: async (options) => {
      await releaseInpaintingBeforeGemma(options);
      return startModelEndpointSession(runtime, options);
    },
    collectOcrHints: async (options) => {
      await releaseGpuBeforeOcr([options]);
      return runtime.simplePage.collectOcrBboxHints(options);
    },
    collectOcrHintsBatch: async (optionsList) => {
      await releaseGpuBeforeOcr(optionsList);
      if (runtime.simplePage.collectOcrBboxHintsBatch) {
        return runtime.simplePage.collectOcrBboxHintsBatch(optionsList);
      }
      const results: OcrBboxResult[] = [];
      for (const options of optionsList) {
        results.push(await runtime.simplePage.collectOcrBboxHints(options));
      }
      return results;
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

  cachedPort = port;
  return cachedPort;
}
