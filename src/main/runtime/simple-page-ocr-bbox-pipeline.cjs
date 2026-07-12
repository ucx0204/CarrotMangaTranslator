// @ts-check
const { existsSync, readFileSync } = require("node:fs");
const { mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  extractJsonText,
  normalizeOcrBboxHintPayload,
} = require("./simple-page-ocr-hints.cjs");
const {
  createOcrBatchProgressFilePoller,
  parseOcrBatchProgressLine,
  resolveOcrBboxTimeoutMs,
} = require("./simple-page-progress.cjs");
const {
  readOcrCandidateText,
  readPositiveInteger,
} = require("./simple-page-prompts.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrGpuFailureMessage,
  isOcrGpuRequested,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrGpuBackend,
  summarizeOcrErrorMessage,
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  createOcrCommandProgressHandler,
} = require("./simple-page-ocr-progress-handlers.cjs");
const {
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
} = require("./simple-page-ocr-commands.cjs");
const {
  createOcrRuntimeError,
  ensurePaddleOcrRuntime,
} = require("./simple-page-ocr-runtime-manager.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
  truncateText,
} = require("./simple-page-runtime-common.cjs");
const {
  isPaddleOcrModelAssetLoadFailure,
  repairPaddleOcrModelAssetsCache,
} = require("./simple-page-model-assets.cjs");
const { runShellCommand } = require("./simple-page-shell-utils.cjs");
const { createOcrBatchConfig } = require("./ocr/bbox-batch-config.cjs");
const { createOcrBatchFiles } = require("./ocr/bbox-batch-files.cjs");
const { createOcrBatchPipeline } = require("./ocr/bbox-batch-pipeline.cjs");
const { createOcrBatchProgress } = require("./ocr/bbox-batch-progress.cjs");
const { createOcrBatchRecovery } = require("./ocr/bbox-batch-recovery.cjs");
const { createOcrCommandRunner } = require("./ocr/bbox-command-runner.cjs");
const { createOcrCpuWorkers } = require("./ocr/bbox-cpu-workers.cjs");
const { createOcrGpuPolicy } = require("./ocr/bbox-gpu-policy.cjs");
const { createOcrBboxResults } = require("./ocr/bbox-results.cjs");
const { createOcrSinglePipeline } = require("./ocr/bbox-single-pipeline.cjs");

const gpuPolicy = createOcrGpuPolicy({
  emitRuntimeProgress,
  isOcrGpuRequested,
  isPaddleOcrModelAssetLoadFailure,
  resolveOcrGpuBackend,
  runtimeOverrideEnv,
  truncateText,
});

const bboxResults = createOcrBboxResults({
  normalizeOcrBboxHintPayload,
  readOcrCandidateText,
  summarizeOcrErrorMessage,
});

const commandRunner = createOcrCommandRunner({
  buildOcrBboxCommand,
  buildOcrRuntimeEnv,
  createDetailedError,
  createOcrCommandProgressHandler,
  emitRuntimeProgress,
  ensurePaddleOcrRuntime,
  existsSync,
  extractJsonText,
  isPaddleOcrModelAssetLoadFailure,
  mkdir,
  path,
  readFile,
  repairPaddleOcrModelAssetsCache,
  resolveOcrBboxTimeoutMs,
  resolveOcrDeviceLabel,
  runShellCommand,
  truncateText,
});

const singlePipeline = createOcrSinglePipeline({
  ...bboxResults,
  ...commandRunner,
  ...gpuPolicy,
  buildPaddleOcrGpuFailureMessage,
  createOcrRuntimeError,
  emitRuntimeProgress,
  isOcrGpuRequested,
  normalizeOcrBboxHintPayload,
  readFile,
  resolveEffectiveOcrDevice,
  resolveOcrDeviceLabel,
  runtimeOverrideEnv,
  summarizeOcrErrorMessage,
  truncateText,
});

const batchConfig = createOcrBatchConfig({
  emitRuntimeProgress,
  os,
  readPositiveInteger,
  runtimeOverrideEnv,
});

const batchFiles = createOcrBatchFiles({
  existsSync,
  readFileSync,
  rm,
  runtimeOverrideEnv,
  safeCleanup,
});

const batchProgress = createOcrBatchProgress({
  emitRuntimeProgress,
  parseOcrBatchProgressLine,
  readPositiveInteger,
});

const batchRecovery = createOcrBatchRecovery({
  ...batchFiles,
  ...bboxResults,
  ...gpuPolicy,
  buildPaddleOcrGpuFailureMessage,
  emitRuntimeProgress,
  isOcrGpuRequested,
  normalizeOcrBboxHintPayload,
  path,
  readPositiveInteger,
  resolveEffectiveOcrDevice,
});

const cpuWorkers = createOcrCpuWorkers({
  ...batchConfig,
  ...batchFiles,
  ...batchProgress,
  ...batchRecovery,
  ...bboxResults,
  ...commandRunner,
  buildOcrBboxBatchCommand,
  createDetailedError,
  createOcrBatchProgressFilePoller,
  createOcrCommandProgressHandler,
  emitRuntimeProgress,
  mkdir,
  normalizeOcrBboxHintPayload,
  path,
  readPositiveInteger,
  resolveOcrBboxTimeoutMs,
  truncateText,
  writeFile,
});

const batchPipeline = createOcrBatchPipeline({
  ...batchConfig,
  ...batchFiles,
  ...batchProgress,
  ...batchRecovery,
  ...bboxResults,
  ...commandRunner,
  ...gpuPolicy,
  ...singlePipeline,
  ...cpuWorkers,
  buildOcrBboxBatchCommand,
  buildPaddleOcrGpuFailureMessage,
  createDetailedError,
  createOcrBatchProgressFilePoller,
  createOcrCommandProgressHandler,
  emitRuntimeProgress,
  ensurePaddleOcrRuntime,
  isOcrGpuRequested,
  mkdir,
  normalizeOcrBboxHintPayload,
  path,
  readPositiveInteger,
  resolveEffectiveOcrDevice,
  resolveOcrBboxTimeoutMs,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  rm,
  truncateText,
  writeFile,
});

module.exports = {
  buildCpuFallbackOcrOptions: gpuPolicy.buildCpuFallbackOcrOptions,
  canFallBackToCpuAfterGpuFailure: gpuPolicy.canFallBackToCpuAfterGpuFailure,
  collectOcrBboxHints: singlePipeline.collectOcrBboxHints,
  collectOcrBboxHintsBatch: batchPipeline.collectOcrBboxHintsBatch,
  disableOcrGpuForSession: gpuPolicy.disableOcrGpuForSession,
  hasOcrCpuWorkerRamHeadroom: batchConfig.hasOcrCpuWorkerRamHeadroom,
  isOcrGpuDisabledForSession: gpuPolicy.isOcrGpuDisabledForSession,
  readCompletedOcrBatchOutputPayload:
    batchFiles.readCompletedOcrBatchOutputPayload,
  resetOcrGpuSessionState: gpuPolicy.resetOcrGpuSessionState,
  resolveOcrCpuWorkerCount: batchConfig.resolveOcrCpuWorkerCount,
  resolveOcrCpuWorkerMinFreeRamRatio:
    batchConfig.resolveOcrCpuWorkerMinFreeRamRatio,
  resolveOcrBboxProvider: gpuPolicy.resolveOcrBboxProvider,
  shouldApplySessionCpuOverride: gpuPolicy.shouldApplySessionCpuOverride,
};
