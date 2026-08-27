// @ts-check
const {
  resolveConfiguredApiBaseUrl,
  resolveConfiguredApiCustomHeadersJson,
  resolveConfiguredApiExtraBodyJson,
  resolveConfiguredApiKey,
  resolveConfiguredApiModel,
  resolveConfiguredApiReasoningEffort,
  resolveConfiguredApiTemperature,
  resolveConfiguredApiTopK,
  resolveConfiguredApiTopP,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  resolveModelProvider,
} = require("../simple-page-model-config.cjs");
const {
  resolveHfHomeDir,
  resolveHubCacheDir,
} = require("../simple-page-cache-paths.cjs");
const {
  resolveConfiguredMmprojUrl,
} = require("../simple-page-model-assets.cjs");
const {
  resolveConfiguredApiCustomHeaders,
  resolveConfiguredApiExtraBody,
} = require("../simple-page-request-builders.cjs");

/** @param {Record<string, any>} options */
function buildArtifactSettings(options) {
  return {
    ...buildGenerationSettings(options),
    ...buildRuntimeSettings(options),
    ...buildModelSettings(options),
    ...buildApiSettings(options),
    ...buildImageSettings(options),
    ...buildOcrSettings(options),
    hfHomeDir: resolveHfHomeDir(options),
    hfHubCacheDir: resolveHubCacheDir(options),
  };
}

/** @param {Record<string, any>} options */
function buildGenerationSettings(options) {
  return {
    port: options.port,
    strictRefineMode: Boolean(options.strictRefineMode),
    previousBlocksForPromptCount: Array.isArray(options.previousBlocksForPrompt)
      ? options.previousBlocksForPrompt.length
      : 0,
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    maxTokens: options.maxTokens,
  };
}

/** @param {Record<string, any>} options */
function buildRuntimeSettings(options) {
  return {
    ctx: options.ctx,
    batch: options.batch,
    ubatch: options.ubatch,
    gemmaVramMode: options.gemmaVramMode,
    fitTargetMb: options.fitTargetMb,
    fitEnabled: options.fitEnabled,
    gpuMemoryMb: options.gpuMemoryMb,
    cacheTypeK: options.cacheTypeK,
    cacheTypeV: options.cacheTypeV,
    ctxCheckpoints: options.ctxCheckpoints,
    kvOffload: options.kvOffload,
    mmprojOffload: options.mmprojOffload,
    threads: options.threads,
    threadsBatch: options.threadsBatch,
    poll: options.poll,
    pollBatch: options.pollBatch,
    prioBatch: options.prioBatch,
    cacheIdleSlots: options.cacheIdleSlots,
    cacheReuse: options.cacheReuse,
    enableMetrics: options.enableMetrics,
    enablePerf: options.enablePerf,
  };
}

/** @param {Record<string, any>} options */
function buildModelSettings(options) {
  return {
    modelProvider: resolveModelProvider(options),
    modelSource: resolveConfiguredModelSource(options),
    modelRepo: resolveConfiguredModelRepo(options),
    modelFile: resolveConfiguredModelFile(options),
    mmprojRepo: resolveConfiguredMmprojRepo(options),
    mmprojFile: resolveConfiguredMmprojFile(options),
    mmprojUrl: resolveConfiguredMmprojUrl(options),
    localModelPath: resolveConfiguredLocalModelPath(options),
    localMmprojPath: resolveConfiguredLocalMmprojPath(options),
    codexModel: resolveConfiguredCodexModel(options),
    codexReasoningEffort: resolveConfiguredCodexReasoningEffort(options),
    codexOauthPort: options.codexOauthPort,
  };
}

/** @param {Record<string, any>} options */
function buildApiSettings(options) {
  return {
    apiBaseUrl: resolveConfiguredApiBaseUrl(options),
    apiModel: resolveConfiguredApiModel(options),
    apiKeyConfigured: Boolean(resolveConfiguredApiKey(options)),
    apiTemperature: resolveConfiguredApiTemperature(options),
    apiTopP: resolveConfiguredApiTopP(options),
    apiTopK: resolveConfiguredApiTopK(options),
    apiReasoningEffort: resolveConfiguredApiReasoningEffort(options),
    apiExtraBodyConfigured: Boolean(resolveConfiguredApiExtraBodyJson(options)),
    apiExtraBodyKeys: Object.keys(resolveConfiguredApiExtraBody(options)),
    apiCustomHeadersConfigured: Boolean(
      resolveConfiguredApiCustomHeadersJson(options),
    ),
    apiCustomHeaderKeys: Object.keys(
      resolveConfiguredApiCustomHeaders(options),
    ),
  };
}

/** @param {Record<string, any>} options */
function buildImageSettings(options) {
  return {
    imageMinTokens: options.imageMinTokens,
    imageMaxTokens: options.imageMaxTokens,
    includeEnhancedVariant: options.includeEnhancedVariant,
    enhancedMaxLongSide: options.enhancedMaxLongSide,
    enhancedContrast: options.enhancedContrast,
  };
}

/** @param {Record<string, any>} options */
function buildOcrSettings(options) {
  return {
    ocrBboxMode: options.ocrBboxMode,
    ocrEngine: options.ocrEngine,
    ocrEngineDtype: options.ocrEngineDtype,
    ocrVersion: options.ocrVersion,
    ocrTextDetectionModelName: options.ocrTextDetectionModelName,
    ocrTextRecognitionModelName: options.ocrTextRecognitionModelName,
    ocrMergeMode: options.ocrMergeMode,
    ocrDetLimit: options.ocrDetLimit,
    ocrRecBatch: options.ocrRecBatch,
  };
}

module.exports = { buildArtifactSettings };
