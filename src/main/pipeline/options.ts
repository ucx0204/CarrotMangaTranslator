import { join } from "node:path";
import {
  buildBaseTranslationOptions,
  type TranslationOptions,
} from "../appSettings";
import { getAppPaths, type AppPaths } from "../appPaths";
import type { AppSettings } from "../../shared/settingsTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { parseApiKeys } from "../../shared/apiKeySettings";
import { tMain } from "./localization";

export function buildBaseOptions(
  jobId: string,
  runDir: string,
  settings: AppSettings,
  paths: AppPaths = getAppPaths(),
  env: NodeJS.ProcessEnv = process.env,
): TranslationOptions {
  return buildBaseTranslationOptions({
    jobId,
    runDir,
    paths,
    settings,
    env,
  });
}

export function buildPageOptions(
  baseOptions: TranslationOptions,
  page: MangaPage,
  index: number,
  attempt: number,
): TranslationOptions {
  return {
    ...baseOptions,
    imagePath: page.imagePath,
    imageWidth: page.width,
    imageHeight: page.height,
    pageId: page.id,
    pageIndex: index,
    outputDir: join(
      baseOptions.outputDir,
      "pages",
      page.id,
      `attempt-${attempt}`,
    ),
    label: `page-${index + 1}-attempt-${attempt}`,
  };
}

export function formatGemmaVramMode(
  mode: TranslationOptions["gemmaVramMode"],
): string {
  if (mode === "minimum12b") {
    return tMain("translation.vram.minimum12b");
  }
  if (mode === "economy26b") {
    return tMain("translation.vram.economy26b");
  }
  return tMain("translation.vram.full31b");
}

export function summarizeTranslationOptions(
  options: TranslationOptions,
): Record<string, unknown> {
  return {
    label: options.label,
    imagePath: options.imagePath,
    outputDir: options.outputDir,
    ...summarizeEngineContext(options),
    port: options.port,
    strictRefineMode: options.strictRefineMode,
    previousBlocksForPrompt: options.previousBlocksForPrompt?.length,
    promptOverrideText: options.promptOverrideText
      ? summarizePreview(options.promptOverrideText, 600)
      : undefined,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    maxTokens: options.maxTokens,
    ctx: options.ctx,
    batch: options.batch,
    ubatch: options.ubatch,
    gemmaVramMode: options.gemmaVramMode,
    fitTargetMb: options.fitTargetMb,
    gpuLayers: options.gpuLayers,
    cacheTypeK: options.cacheTypeK,
    cacheTypeV: options.cacheTypeV,
    ctxCheckpoints: options.ctxCheckpoints,
    kvOffload: options.kvOffload,
    mmprojOffload: options.mmprojOffload,
    useDraft: options.useDraft,
    draftModelRepo: options.draftModelRepo,
    draftModelFile: options.draftModelFile,
    imageMinTokens: options.imageMinTokens,
    imageMaxTokens: options.imageMaxTokens,
    includeEnhancedVariant: options.includeEnhancedVariant,
    enhancedMaxLongSide: options.enhancedMaxLongSide,
    enhancedContrast: options.enhancedContrast,
    ...summarizeRegionOptions(options),
    imageFirst: options.imageFirst,
    reuseServer: options.reuseServer,
    llamaRuntimeProfile: options.llamaRuntimeProfile,
    llamaRocmTarget: options.llamaRocmTarget,
    workingDir: options.workingDir,
    toolsDir: options.toolsDir,
    serverPath: options.serverPath,
    modelRepo: options.modelRepo,
    modelFile: options.modelFile,
    mmprojRepo: options.mmprojRepo,
    mmprojFile: options.mmprojFile,
    ...summarizeRemoteModelOptions(options),
    ocrDevice: options.ocrDevice,
    ocrGpuBackend: options.ocrGpuBackend,
    ocrGpuCudaTag: options.ocrGpuCudaTag,
    ocrQualityMode: options.ocrQualityMode,
    ocrBboxMode: options.ocrBboxMode,
    ocrEngine: options.ocrEngine,
    ocrEngineDtype: options.ocrEngineDtype,
    ocrVersion: options.ocrVersion,
    ocrTextDetectionModelName: options.ocrTextDetectionModelName,
    ocrTextRecognitionModelName: options.ocrTextRecognitionModelName,
    ocrMergeMode: options.ocrMergeMode,
    ocrDetLimit: options.ocrDetLimit,
    ocrRecBatch: options.ocrRecBatch,
    hfHomeDir: options.hfHomeDir ?? null,
    hfHubCacheDir: options.hfHubCacheDir ?? null,
    workContext: summarizeWorkContext(options),
    workContextBudget: summarizeWorkContextBudget(options),
  };
}

function summarizeRemoteModelOptions(
  options: TranslationOptions,
): Record<string, unknown> {
  return {
    codexModel: options.codexModel,
    codexReasoningEffort: options.codexReasoningEffort,
    codexOauthPort: options.codexOauthPort,
    apiBaseUrl: options.apiBaseUrl,
    apiModel: options.apiModel,
    apiKeyConfigured: Boolean(options.apiKey),
    apiKeyCount: parseApiKeys(options.apiKey).length,
    apiKeyMaxAttempts: options.apiKeyMaxAttempts,
    apiRetryDelaySeconds: options.apiRetryDelaySeconds,
    apiTemperature: options.apiTemperature,
    apiTopP: options.apiTopP,
    apiTopK: options.apiTopK,
    apiReasoningEffort: options.apiReasoningEffort,
    apiExtraBodyConfigured: Boolean(options.apiExtraBodyJson),
    apiCustomHeadersConfigured: Boolean(options.apiCustomHeadersJson),
  };
}

function summarizeEngineContext(
  options: TranslationOptions,
): Record<string, unknown> {
  return {
    modelProvider: options.modelProvider,
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    promptMode: options.promptMode,
  };
}

function summarizeRegionOptions(
  options: TranslationOptions,
): Record<string, unknown> {
  return {
    regionCropMode: options.regionCropMode,
    regionContextImagePath: options.regionContextImagePath,
    regionContextImageWidth: options.regionContextImageWidth,
    regionContextImageHeight: options.regionContextImageHeight,
    regionContextCropRect: options.regionContextCropRect,
  };
}

function summarizeWorkContext(
  options: TranslationOptions,
): Record<string, unknown> | undefined {
  return options.workContext
    ? {
        glossaryCount: options.workContext.styleGuide.glossary.length,
        characterCount: options.workContext.styleGuide.characters.length,
        storyPageCount: options.workContext.storyMemory.pages.length,
        recentPageCount: options.workContext.recentPageCount,
      }
    : undefined;
}

function summarizeWorkContextBudget(
  options: TranslationOptions,
): Record<string, unknown> | undefined {
  return options.workContextBudget
    ? {
        originalTokens: options.workContextBudget.original.totalTokens,
        effectiveTokens: options.workContextBudget.effective.totalTokens,
        outputHeadroomTokens:
          options.workContextBudget.effective.outputHeadroomTokens,
        outputHeadroomPercent:
          options.workContextBudget.effective.outputHeadroomPercent,
        omittedParts: options.workContextBudget.omittedParts,
      }
    : undefined;
}

export function summarizePreview(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1)}…`;
}

export function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
