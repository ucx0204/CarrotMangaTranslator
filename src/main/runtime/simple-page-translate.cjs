const {
  getOverlayPrompt
} = require("./simple-page-prompts.cjs");
const {
  parseOcrBatchProgressLine,
  parsePipRawProgress,
  parsePaddleModelFetchProgress,
  resolveOcrBboxTimeoutMs
} = require("./simple-page-progress.cjs");
const {
  enhanceBitmapBuffer,
  getScaledSize
} = require("./simple-page-image-utils.cjs");
const {
  extractModelOutputText,
  parseResponsesSseText
} = require("./simple-page-response-text.cjs");
const {
  resolveLlamaCppCacheDir,
  resolveManagedHfFilePath
} = require("./simple-page-cache-paths.cjs");
const {
  resolveFfmpegPath
} = require("./simple-page-runtime-paths.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrPipInstallBatches,
  resolvePaddleOcrImportCheckTimeoutMs
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  collectRequiredPaddleOcrModelDownloads
} = require("./simple-page-ocr-model-assets.cjs");
const {
  convertImageToPngBufferWithFfmpeg,
  prepareImageVariants
} = require("./simple-page-image-variants.cjs");
const {
  collectRequiredHfDownloads,
  inspectModelLaunch,
  isModelCached
} = require("./simple-page-model-assets.cjs");
const {
  ensurePaddleOcrRuntime,
  resolveOcrInstallBatchProgressRanges
} = require("./simple-page-ocr-runtime-manager.cjs");
const {
  collectOcrBboxHints,
  collectOcrBboxHintsBatch
} = require("./simple-page-ocr-bbox-pipeline.cjs");
const {
  buildMessages
} = require("./simple-page-request-builders.cjs");
const {
  saveArtifacts
} = require("./simple-page-artifacts.cjs");
const {
  buildResponsesRequestBody,
  requestTranslation,
  testModelReply
} = require("./simple-page-translation-requests.cjs");
const {
  buildLaunchArgs,
  buildLlamaServerEnv,
  startServer,
  stopServer
} = require("./simple-page-server-lifecycle.cjs");

module.exports = {
  buildMessages,
  buildLaunchArgs,
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  buildResponsesRequestBody,
  collectRequiredHfDownloads,
  collectRequiredPaddleOcrModelDownloads,
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  convertImageToPngBufferWithFfmpeg,
  ensurePaddleOcrRuntime,
  enhanceBitmapBuffer,
  extractModelOutputText,
  getOverlayPrompt,
  getScaledSize,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  resolvePaddleOcrImportCheckTimeoutMs,
  resolveOcrBboxTimeoutMs,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrPipInstallBatches,
  resolveOcrInstallBatchProgressRanges,
  resolveFfmpegPath,
  resolveLlamaCppCacheDir,
  buildLlamaServerEnv,
  resolveManagedHfFilePath,
  inspectModelLaunch,
  isModelCached,
  parseResponsesSseText,
  prepareImageVariants,
  requestTranslation,
  saveArtifacts,
  startServer,
  stopServer,
  testModelReply
};
