import type { TranslationOptions } from "../appSettings";
import type { CropRetryItem, CropRetryTarget, ModelEndpointHandle, OcrBboxResult, OverlayItem, TranslationResult } from "./types";
import { loadRuntimeModules, startModelEndpointSession, type ModelEndpointSession } from "./runtimeModules";

export type TranslationRuntimePort = {
  isModelCached: (options: TranslationOptions) => boolean;
  startEndpointSession: (options: TranslationOptions) => Promise<ModelEndpointSession>;
  collectOcrHints: (options: TranslationOptions) => Promise<OcrBboxResult>;
  collectOcrHintsBatch: (options: TranslationOptions[]) => Promise<OcrBboxResult[]>;
  requestTranslation: (endpoint: ModelEndpointHandle, options: TranslationOptions) => Promise<TranslationResult>;
  requestCropRetryTranslation?: (
    endpoint: ModelEndpointHandle,
    options: TranslationOptions,
    targets: CropRetryTarget[]
  ) => Promise<TranslationResult>;
  saveArtifacts: (options: TranslationOptions, result: TranslationResult) => Promise<void>;
  parseJsonLenient: (rawText: string) => unknown;
  normalizeItems: (parsed: unknown) => OverlayItem[];
  parseRetryItems?: (rawText: string) => CropRetryItem[];
};

let cachedPort: TranslationRuntimePort | null = null;

export function loadTranslationRuntimePort(): TranslationRuntimePort {
  if (cachedPort) {
    return cachedPort;
  }

  const runtime = loadRuntimeModules();
  const port: TranslationRuntimePort = {
    isModelCached: (options) => runtime.simplePage.isModelCached(options),
    startEndpointSession: (options) => startModelEndpointSession(runtime, options),
    collectOcrHints: (options) => runtime.simplePage.collectOcrBboxHints(options),
    collectOcrHintsBatch: async (optionsList) => {
      if (runtime.simplePage.collectOcrBboxHintsBatch) {
        return runtime.simplePage.collectOcrBboxHintsBatch(optionsList);
      }
      const results: OcrBboxResult[] = [];
      for (const options of optionsList) {
        results.push(await runtime.simplePage.collectOcrBboxHints(options));
      }
      return results;
    },
    requestTranslation: (endpoint, options) => runtime.simplePage.requestTranslation(endpoint, options),
    saveArtifacts: (options, result) => runtime.simplePage.saveArtifacts(options, result),
    parseJsonLenient: (rawText) => runtime.overlayTools.parseJsonLenient(rawText),
    normalizeItems: (parsed) => runtime.overlayTools.normalizeItems(parsed)
  };

  if (runtime.simplePage.requestCropRetryTranslation && runtime.overlayTools.parseRetryItems) {
    port.requestCropRetryTranslation = (endpoint, options, targets) =>
      runtime.simplePage.requestCropRetryTranslation!(endpoint, options, targets);
    port.parseRetryItems = (rawText) => runtime.overlayTools.parseRetryItems!(rawText);
  }

  cachedPort = port;
  return cachedPort;
}
