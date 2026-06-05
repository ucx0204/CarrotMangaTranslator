const path = require("node:path");

const {
  readOcrCandidateText,
  resolvePromptCoordinateFrame
} = require("./simple-page-prompts.cjs");
const {
  mimeFromPath
} = require("./simple-page-image-utils.cjs");
const {
  isOpenAICodexProvider,
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
  resolveModelProvider
} = require("./simple-page-model-config.cjs");
const {
  resolveHfHomeDir,
  resolveHubCacheDir
} = require("./simple-page-cache-paths.cjs");
const {
  inspectModelLaunch,
  resolveConfiguredMmprojUrl
} = require("./simple-page-model-assets.cjs");
const {
  resolveOcrDevice,
  resolveOcrGpuCudaTag,
  resolveOcrRuntimeDir
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  resolveOcrBboxProvider
} = require("./simple-page-ocr-bbox-pipeline.cjs");
const {
  truncateText
} = require("./simple-page-runtime-common.cjs");

function buildOptionSummary(options = {}) {
  const launchTarget = inspectModelLaunch(options);
  return {
    label: options.label,
    imagePath: options.imagePath,
    outputDir: options.outputDir,
    modelProvider: resolveModelProvider(options),
    port: options.port,
    promptMode: options.promptMode,
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
    imageFirst: options.imageFirst,
    reuseServer: options.reuseServer,
    llamaRuntimeProfile: options.llamaRuntimeProfile,
    workingDir: options.workingDir,
    toolsDir: options.toolsDir,
    serverPath: options.serverPath,
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
    ocrBboxProvider: resolveOcrBboxProvider(options),
    ocrDevice: resolveOcrDevice(options),
    ocrGpuCudaTag: resolveOcrGpuCudaTag(options),
    ocrRuntimeDir: resolveOcrRuntimeDir(options),
    launchMode: launchTarget.launchMode,
    hfHomeDir: resolveHfHomeDir(options),
    hfHubCacheDir: resolveHubCacheDir(options)
  };
}

function summarizeImageVariants(imageVariants) {
  return imageVariants.map((variant) => ({
    role: variant.role,
    path: variant.path,
    mime: variant.mime || mimeFromPath(variant.path),
    convertedFromMime: variant.convertedFromMime || null,
    width: variant.width || null,
    height: variant.height || null,
    originalWidth: variant.originalWidth || null,
    originalHeight: variant.originalHeight || null
  }));
}

function buildRequestSummary(server, options, imageVariants, promptText, systemPrompt) {
  const coordinateFrame = resolvePromptCoordinateFrame(options, imageVariants);
  const ocrBboxHints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  return {
    endpoint: `${server.baseUrl}/${isOpenAICodexProvider(options) ? "responses" : "chat/completions"}`,
    model: resolveRequestModelName(options),
    label: options.label,
    promptMode: options.promptMode,
    promptPreview: truncateText(promptText, 2400),
    systemPromptPreview: truncateText(systemPrompt, 2400),
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
      ocrText: truncateText(readOcrCandidateText(hint), 160) || null
    })),
    ocrBboxHintsPreview: ocrBboxHints.slice(0, 24).map((hint) => ({
      id: hint.id,
      label: hint.label,
      x1: hint.x1,
      y1: hint.y1,
      x2: hint.x2,
      y2: hint.y2,
      score: hint.score ?? null,
      ocrText: truncateText(readOcrCandidateText(hint), 160) || null
    })),
    options: buildOptionSummary(options)
  };
}

function resolveRequestModelName(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return resolveConfiguredCodexModel(options);
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
  resolveRequestModelName
};
