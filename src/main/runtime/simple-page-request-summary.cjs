// @ts-check
const path = require("node:path");

/**
 * @typedef {{ totalTokens?: unknown; outputHeadroomTokens?: unknown; outputHeadroomPercent?: unknown }} TokenBudgetDetail
 * @typedef {{ original?: TokenBudgetDetail; effective?: TokenBudgetDetail; omittedParts?: unknown[] }} WorkContextBudget
 * @typedef {{ id?: unknown; label?: unknown; x1?: unknown; y1?: unknown; x2?: unknown; y2?: unknown; score?: unknown; groupId?: unknown; rolePrior?: unknown; orderInGroup?: unknown; [key: string]: unknown }} OcrBboxHint
 * @typedef {{ role?: string; path: string; mime?: string; convertedFromMime?: unknown; width?: unknown; height?: unknown; originalWidth?: unknown; originalHeight?: unknown; [key: string]: unknown }} ImageVariantSummaryInput
 * @typedef {import("./simple-page-prompts.cjs").PromptOptions} PromptOptions
 * @typedef {{ baseUrl: string }} RequestServer
 * @typedef {{ label?: unknown; imagePath?: string | null; outputDir?: string | null; port?: unknown; promptMode?: unknown; strictRefineMode?: unknown; previousBlocksForPrompt?: unknown[]; temperature?: unknown; topP?: unknown; topK?: unknown; maxTokens?: unknown; ctx?: unknown; batch?: unknown; ubatch?: unknown; gemmaVramMode?: unknown; fitTargetMb?: unknown; cacheTypeK?: unknown; cacheTypeV?: unknown; ctxCheckpoints?: unknown; kvOffload?: unknown; mmprojOffload?: unknown; threads?: unknown; threadsBatch?: unknown; poll?: unknown; pollBatch?: unknown; prioBatch?: unknown; cacheIdleSlots?: unknown; cacheReuse?: unknown; enableMetrics?: unknown; enablePerf?: unknown; useDraft?: boolean | null; imageMinTokens?: unknown; imageMaxTokens?: unknown; includeEnhancedVariant?: unknown; enhancedMaxLongSide?: unknown; enhancedContrast?: unknown; imageFirst?: unknown; reuseServer?: unknown; llamaRuntimeProfile?: unknown; llamaRocmTarget?: string | null; workingDir?: string | null; toolsDir?: string | null; serverPath?: string | null; modelRepo?: unknown; modelFile?: unknown; codexOauthPort?: unknown; workContextBudget?: WorkContextBudget; ocrBboxHints?: OcrBboxHint[]; [key: string]: unknown }} RequestSummaryOptions
 */

const {
  readOcrCandidateText,
  resolvePromptCoordinateFrame,
} = require("./simple-page-prompts.cjs");
const { mimeFromPath } = require("./simple-page-image-utils.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
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
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  resolveModelProvider,
} = require("./simple-page-model-config.cjs");
const {
  resolveHfHomeDir,
  resolveHubCacheDir,
} = require("./simple-page-cache-paths.cjs");
const {
  inspectModelLaunch,
  resolveConfiguredMmprojUrl,
} = require("./simple-page-model-assets.cjs");
const {
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrRuntimeDir,
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  resolveOcrBboxProvider,
} = require("./simple-page-ocr-bbox-pipeline.cjs");
const { truncateText } = require("./simple-page-runtime-common.cjs");
const {
  resolveConfiguredApiCustomHeaders,
  resolveConfiguredApiExtraBody,
} = require("./simple-page-request-builders.cjs");

/**
 * @param {RequestSummaryOptions} [options]
 * @returns {Record<string, unknown>}
 */
function buildOptionSummary(options = {}) {
  const launchTarget = inspectModelLaunch(options);
  return {
    ...buildCoreOptionSummary(options),
    ...buildGenerationOptionSummary(options),
    ...buildModelOptionSummary(options, launchTarget),
    ...buildApiOptionSummary(options),
    ...buildOcrOptionSummary(options),
    workContextBudget: summarizeWorkContextBudget(options.workContextBudget),
  };
}

/** @param {RequestSummaryOptions} options */
function buildCoreOptionSummary(options) {
  const previousBlocksForPromptCount = Array.isArray(
    options.previousBlocksForPrompt,
  )
    ? options.previousBlocksForPrompt.length
    : 0;
  return {
    label: options.label,
    imagePath: options.imagePath,
    outputDir: options.outputDir,
    modelProvider: resolveModelProvider(options),
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
    port: options.port,
    promptMode: options.promptMode,
    strictRefineMode: Boolean(options.strictRefineMode),
    keepBlocksMode: Boolean(options.keepBlocksMode),
    previousBlocksForPromptCount,
    regionCropMode: Boolean(options.regionCropMode),
    regionContextImagePath: options.regionContextImagePath || undefined,
    regionContextImageWidth: options.regionContextImageWidth || undefined,
    regionContextImageHeight: options.regionContextImageHeight || undefined,
    regionContextCropRect: options.regionContextCropRect || undefined,
    imageFirst: options.imageFirst,
    reuseServer: options.reuseServer,
    workingDir: options.workingDir,
    toolsDir: options.toolsDir,
    serverPath: options.serverPath,
  };
}

/** @param {RequestSummaryOptions} options */
function buildGenerationOptionSummary(options) {
  return {
    temperature: options.temperature,
    topP: options.topP,
    topK: options.topK,
    maxTokens: options.maxTokens,
    ctx: options.ctx,
    batch: options.batch,
    ubatch: options.ubatch,
    gemmaVramMode: options.gemmaVramMode,
    fitTargetMb: options.fitTargetMb,
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
    useDraft: Boolean(options.useDraft),
    draftModelRepo: resolveConfiguredDraftModelRepo(options),
    draftModelFile: resolveConfiguredDraftModelFile(options),
    imageMinTokens: options.imageMinTokens,
    imageMaxTokens: options.imageMaxTokens,
    includeEnhancedVariant: options.includeEnhancedVariant,
    enhancedMaxLongSide: options.enhancedMaxLongSide,
    enhancedContrast: options.enhancedContrast,
  };
}

/**
 * @param {RequestSummaryOptions} options
 * @param {ReturnType<typeof inspectModelLaunch>} launchTarget
 */
function buildModelOptionSummary(options, launchTarget) {
  return {
    llamaRuntimeProfile: options.llamaRuntimeProfile,
    llamaRocmTarget: options.llamaRocmTarget,
    modelSource: resolveConfiguredModelSource(options),
    modelRepo: options.modelRepo,
    modelFile: options.modelFile,
    mmprojRepo: resolveConfiguredMmprojRepo(options),
    mmprojFile: resolveConfiguredMmprojFile(options),
    mmprojUrl: resolveConfiguredMmprojUrl(options),
    draftModelPath: launchTarget.draftModelPath ?? null,
    draftModelUrl: launchTarget.draftModelUrl ?? null,
    localModelPath: resolveConfiguredLocalModelPath(options),
    localMmprojPath: resolveConfiguredLocalMmprojPath(options),
    codexModel: resolveConfiguredCodexModel(options),
    codexReasoningEffort: resolveConfiguredCodexReasoningEffort(options),
    codexOauthPort: options.codexOauthPort,
    launchMode: launchTarget.launchMode,
    hfHomeDir: resolveHfHomeDir(options),
    hfHubCacheDir: resolveHubCacheDir(options),
  };
}

/** @param {RequestSummaryOptions} options */
function buildApiOptionSummary(options) {
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

/** @param {RequestSummaryOptions} options */
function buildOcrOptionSummary(options) {
  return {
    ocrBboxProvider: resolveOcrBboxProvider(options),
    ocrDevice: resolveOcrDevice(options),
    ocrGpuBackend: resolveOcrGpuBackend(options),
    ocrGpuCudaTag: resolveOcrGpuCudaTag(options),
    ocrBboxMode: options.ocrBboxMode,
    ocrEngine: options.ocrEngine,
    ocrEngineDtype: options.ocrEngineDtype,
    ocrVersion: options.ocrVersion,
    ocrTextDetectionModelName: options.ocrTextDetectionModelName,
    ocrTextRecognitionModelName: options.ocrTextRecognitionModelName,
    ocrMergeMode: options.ocrMergeMode,
    ocrDetLimit: options.ocrDetLimit,
    ocrRecBatch: options.ocrRecBatch,
    ocrRuntimeDir: resolveOcrRuntimeDir(options),
  };
}

/** @param {WorkContextBudget | undefined} budget */
function summarizeWorkContextBudget(budget) {
  if (!budget) {
    return undefined;
  }
  return {
    originalTokens: budget.original?.totalTokens,
    effectiveTokens: budget.effective?.totalTokens,
    outputHeadroomTokens: budget.effective?.outputHeadroomTokens,
    outputHeadroomPercent: budget.effective?.outputHeadroomPercent,
    omittedParts: budget.omittedParts || [],
  };
}

/**
 * @param {ImageVariantSummaryInput[]} imageVariants
 * @returns {Array<Record<string, unknown>>}
 */
function summarizeImageVariants(imageVariants) {
  return imageVariants.map((variant) => ({
    role: variant.role,
    path: variant.path,
    mime: variant.mime || mimeFromPath(variant.path),
    convertedFromMime: variant.convertedFromMime || null,
    width: variant.width || null,
    height: variant.height || null,
    originalWidth: variant.originalWidth || null,
    originalHeight: variant.originalHeight || null,
  }));
}

/**
 * @param {RequestServer} server
 * @param {RequestSummaryOptions} options
 * @param {ImageVariantSummaryInput[]} imageVariants
 * @param {string} promptText
 * @param {string} systemPrompt
 * @returns {Record<string, unknown>}
 */
function buildRequestSummary(
  server,
  options,
  imageVariants,
  promptText,
  systemPrompt,
) {
  const coordinateFrame = resolvePromptCoordinateFrame(
    /** @type {PromptOptions} */ (options),
    imageVariants,
  );
  const ocrBboxHints = Array.isArray(options.ocrBboxHints)
    ? options.ocrBboxHints
    : [];
  return {
    endpoint: `${server.baseUrl}/${isOpenAICodexProvider(options) ? "responses" : "chat/completions"}`,
    model: resolveRequestModelName(options),
    label: options.label,
    promptMode: options.promptMode,
    promptPreview: truncateText(promptText, 2400),
    systemPromptPreview: truncateText(systemPrompt, 2400),
    strictRefineMode: Boolean(options.strictRefineMode),
    keepBlocksMode: Boolean(options.keepBlocksMode),
    previousBlocksForPrompt: Array.isArray(options.previousBlocksForPrompt)
      ? options.previousBlocksForPrompt.slice(0, 80)
      : [],
    imageVariants: summarizeImageVariants(imageVariants),
    bboxCoordinateSpace: coordinateFrame.space,
    bboxCoordinateFrame: coordinateFrame.frame,
    ocrBboxHintCount: ocrBboxHints.length,
    ocrBboxHints: ocrBboxHints.slice(0, 80).map((hint) => ({
      id: hint.id,
      label: hint.label,
      x1: hint.x1,
      y1: hint.y1,
      x2: hint.x2,
      y2: hint.y2,
      score: hint.score ?? null,
      groupId: hint.groupId ?? null,
      rolePrior: hint.rolePrior ?? null,
      containerType: hint.containerType ?? null,
      orderInGroup: hint.orderInGroup ?? null,
      ocrText: truncateText(readOcrCandidateText(hint), 160) || null,
    })),
    ocrBboxHintsPreview: ocrBboxHints.slice(0, 24).map((hint) => ({
      id: hint.id,
      label: hint.label,
      x1: hint.x1,
      y1: hint.y1,
      x2: hint.x2,
      y2: hint.y2,
      score: hint.score ?? null,
      groupId: hint.groupId ?? null,
      rolePrior: hint.rolePrior ?? null,
      containerType: hint.containerType ?? null,
      orderInGroup: hint.orderInGroup ?? null,
      ocrText: truncateText(readOcrCandidateText(hint), 160) || null,
    })),
    options: buildOptionSummary(options),
  };
}

/**
 * @param {RequestSummaryOptions} [options]
 * @returns {string}
 */
function resolveRequestModelName(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return resolveConfiguredCodexModel(options);
  }
  if (isOpenAIApiProvider(options)) {
    return resolveConfiguredApiModel(options);
  }
  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.launchMode === "local" && launchTarget.modelPath) {
    return path.basename(launchTarget.modelPath);
  }
  return resolveConfiguredModelRepo(options);
}

module.exports = {
  buildOptionSummary,
  buildRequestSummary,
  resolveRequestModelName,
};
