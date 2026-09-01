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
  buildOcrGpuFailureMessage,
  isHayaiOcrPipeline,
  isManagedOcrBboxProvider,
  isOcrGpuRequested,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrBboxProviderForRequest,
  resolveOcrEngineLabel,
  resolveOcrRuntimeVariant,
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
  ensureOcrRuntime,
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
const {
  formatCommandForLog,
  runCommand,
} = require("./simple-page-shell-utils.cjs");
const { createOcrBatchConfig } = require("./ocr/bbox-batch-config.cjs");
const { createOcrBatchFiles } = require("./ocr/bbox-batch-files.cjs");
const { createOcrBatchPipeline } = require("./ocr/bbox-batch-pipeline.cjs");
const { createOcrBatchProgress } = require("./ocr/bbox-batch-progress.cjs");
const { createOcrCommandRunner } = require("./ocr/bbox-command-runner.cjs");
const { createOcrCpuWorkers } = require("./ocr/bbox-cpu-workers.cjs");
const { createOcrGpuPolicy } = require("./ocr/bbox-gpu-policy.cjs");
const { createOcrBboxResults } = require("./ocr/bbox-results.cjs");
const { createOcrSinglePipeline } = require("./ocr/bbox-single-pipeline.cjs");

const gpuPolicy = createOcrGpuPolicy({
  resolveOcrBboxProviderForRequest,
  runtimeOverrideEnv,
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
  ensureOcrRuntime,
  existsSync,
  extractJsonText,
  isHayaiOcrPipeline,
  isManagedOcrBboxProvider,
  isPaddleOcrModelAssetLoadFailure,
  mkdir,
  path,
  readFile,
  repairPaddleOcrModelAssetsCache,
  resolveOcrBboxTimeoutMs,
  formatCommandForLog,
  resolveOcrDeviceLabel,
  resolveOcrEngineLabel,
  runCommand,
  truncateText,
});

const singlePipeline = createOcrSinglePipeline({
  ...bboxResults,
  ...commandRunner,
  ...gpuPolicy,
  buildOcrGpuFailureMessage,
  createOcrRuntimeError,
  emitRuntimeProgress,
  isOcrGpuRequested,
  isManagedOcrBboxProvider,
  normalizeOcrBboxHintPayload,
  readFile,
  resolveEffectiveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrEngineLabel,
  runtimeOverrideEnv,
  truncateText,
});

const batchConfig = createOcrBatchConfig({
  emitRuntimeProgress,
  isHayaiOcrPipeline,
  os,
  readPositiveInteger,
  resolveOcrEngineLabel,
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
  resolveOcrEngineLabel,
});

const cpuWorkers = createOcrCpuWorkers({
  ...batchConfig,
  ...batchFiles,
  ...batchProgress,
  ...bboxResults,
  ...commandRunner,
  buildOcrBboxBatchCommand,
  createDetailedError,
  formatCommandForLog,
  createOcrBatchProgressFilePoller,
  createOcrCommandProgressHandler,
  emitRuntimeProgress,
  mkdir,
  normalizeOcrBboxHintPayload,
  path,
  readPositiveInteger,
  resolveOcrBboxTimeoutMs,
  resolveOcrEngineLabel,
  truncateText,
  writeFile,
});

const batchPipeline = createOcrBatchPipeline({
  ...batchConfig,
  ...batchFiles,
  ...batchProgress,
  ...bboxResults,
  ...commandRunner,
  ...gpuPolicy,
  ...singlePipeline,
  ...cpuWorkers,
  buildOcrBboxBatchCommand,
  buildOcrGpuFailureMessage,
  formatCommandForLog,
  createDetailedError,
  createOcrRuntimeError,
  createOcrBatchProgressFilePoller,
  createOcrCommandProgressHandler,
  emitRuntimeProgress,
  ensureOcrRuntime,
  isOcrGpuRequested,
  isManagedOcrBboxProvider,
  mkdir,
  normalizeOcrBboxHintPayload,
  path,
  readPositiveInteger,
  resolveEffectiveOcrDevice,
  resolveOcrBboxTimeoutMs,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrEngineLabel,
  resolveOcrRuntimeVariant,
  rm,
  truncateText,
  writeFile,
});

const activeOcrOperations = new Set();

/** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
function trackOcrOperation(operation) {
  const active = Promise.resolve().then(operation);
  const tracked = active.finally(() => activeOcrOperations.delete(tracked));
  activeOcrOperations.add(tracked);
  return tracked;
}

/** @param {Record<string, unknown>} options */
function collectOcrBboxHints(options) {
  return trackOcrOperation(() => singlePipeline.collectOcrBboxHints(options));
}

/** @param {Record<string, unknown>[]} optionsList */
function collectOcrBboxHintsBatch(optionsList) {
  return trackOcrOperation(() =>
    batchPipeline.collectOcrBboxHintsBatch(optionsList),
  );
}

/**
 * Translation must never start while an OCR child process is still closing.
 * The command runner resolves on the child's `close` event, so an empty set is
 * also the proof that its Python model/runtime has left the process tree.
 */
async function waitForOcrIdle() {
  while (activeOcrOperations.size > 0) {
    await Promise.allSettled([...activeOcrOperations]);
  }
}

module.exports = {
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  hasOcrCpuWorkerRamHeadroom: batchConfig.hasOcrCpuWorkerRamHeadroom,
  readCompletedOcrBatchOutputPayload:
    batchFiles.readCompletedOcrBatchOutputPayload,
  resolveOcrCpuWorkerCount: batchConfig.resolveOcrCpuWorkerCount,
  resolveOcrCpuWorkerMinFreeRamRatio:
    batchConfig.resolveOcrCpuWorkerMinFreeRamRatio,
  resolveOcrBboxProvider: gpuPolicy.resolveOcrBboxProvider,
  waitForOcrIdle,
};
