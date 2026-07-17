// @ts-check
const { rm } = require("node:fs/promises");
const { runtimeOverrideEnv } = require("../simple-page-child-env.cjs");
const {
  downloadHfFileWithProgress,
  getFileSize,
  mapWithConcurrency,
  probeContentLength,
  resolveDownloadRangeConcurrency,
} = require("../simple-page-download-utils.cjs");
const {
  collectRequiredPaddleOcrModelDownloads,
} = require("../simple-page-ocr-model-assets.cjs");
const {
  emitRuntimeProgress,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  inspectPaddleOcrAssetFile,
  isPaddleOcrModelAssetLoadFailure,
} = require("./paddle-model-validation.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} ModelAssetOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {{ kind: string; label: string; repo?: string; file: string; url: string; destination: string; progressPhase?: string; progressTitle?: string; completeTitle?: string }} DownloadTask */

/** @param {ModelAssetOptions} [options] @param {OcrRuntimeLayout | null} [runtime] */
async function ensurePaddleOcrModelAssetsDownloaded(
  options = {},
  runtime = null,
) {
  if (shouldSkipPrefetch(options)) return;
  const plan = await buildPaddleDownloadPlan(options, runtime);
  if (plan.pending.length === 0) return;
  const aggregate = buildAggregate(plan.totals, plan.pending.length);
  emitPaddleDownloadStart(options, plan.pending.length, aggregate);
  await downloadPaddleTasks(options, plan.pending, plan.totals, aggregate);
  emitPaddleDownloadComplete(options, aggregate);
}

/** @param {ModelAssetOptions} options */
function shouldSkipPrefetch(options) {
  return isTruthy(
    runtimeOverrideEnv(
      "MANGA_TRANSLATOR_SKIP_PADDLE_MODEL_PREFETCH",
      options,
    ) ?? "false",
  );
}

/** @param {ModelAssetOptions} options @param {OcrRuntimeLayout | null} runtime */
async function buildPaddleDownloadPlan(options, runtime) {
  const pending = [];
  const totals = new Map();
  const tasks = collectRequiredPaddleOcrModelDownloads(options, runtime);
  const inspected = await mapWithConcurrency(
    tasks,
    resolveDownloadRangeConcurrency(),
    async (task) => ({
      task,
      inspection: await inspectDownloadTask(options, task),
    }),
  );
  for (const { task, inspection } of inspected) {
    if (!inspection.pending) continue;
    pending.push(task);
    if (inspection.totalBytes > 0)
      totals.set(task.destination, inspection.totalBytes);
  }
  return { pending, totals };
}

/** @param {ModelAssetOptions} options @param {DownloadTask} task */
async function inspectDownloadTask(options, task) {
  const totalBytes = await probeContentLength(task.url, options.abortSignal);
  const existingSize = getFileSize(task.destination);
  const problem = inspectPaddleOcrAssetFile(task.destination, task.file);
  if (problem) {
    await removeCorruptAsset(options, task, problem);
    return { pending: true, totalBytes };
  }
  if (assetMatchesRemoteSize(existingSize, totalBytes))
    return { pending: false, totalBytes };
  if (existingSize > 0 && totalBytes > 0) {
    await safeCleanup("remove partial Paddle OCR model asset", () =>
      rm(task.destination, { force: true }),
    );
  }
  return { pending: true, totalBytes };
}

/** @param {number} existingSize @param {number} totalBytes */
function assetMatchesRemoteSize(existingSize, totalBytes) {
  return totalBytes > 0 ? existingSize === totalBytes : existingSize > 0;
}

/** @param {ModelAssetOptions} options @param {DownloadTask} task @param {string} problem */
async function removeCorruptAsset(options, task, problem) {
  await safeCleanup("remove corrupt Paddle OCR model asset", () =>
    rm(task.destination, { force: true }),
  );
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 파일 재검사 중",
    `${task.label}: ${task.file}`,
    {
      progressMode: "log-only",
      installLogLine: `깨진 OCR 모델 파일을 다시 받습니다: ${task.file} (${problem})`,
    },
  );
}

/** @param {Map<string, number>} totals @param {number} taskCount */
function buildAggregate(totals, taskCount) {
  const totalBytes = [...totals.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  return { totalBytes, known: totalBytes > 0 && totals.size === taskCount };
}

/** @param {ModelAssetOptions} options @param {number} count @param {ReturnType<typeof buildAggregate>} aggregate */
function emitPaddleDownloadStart(options, count, aggregate) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 파일 다운로드 중",
    `${count}개 파일 준비`,
    {
      progressMode: aggregate.known ? "determinate" : "log-only",
      progressPercent: aggregate.known ? 0 : undefined,
      progressBytes: 0,
      progressTotalBytes: aggregate.known ? aggregate.totalBytes : undefined,
      installLogLine: `Paddle OCR 모델 다운로드 대상 ${count}개 파일을 확인했습니다.`,
    },
  );
}

/** @param {ModelAssetOptions} options @param {DownloadTask[]} tasks @param {Map<string, number>} totals @param {ReturnType<typeof buildAggregate>} aggregate */
async function downloadPaddleTasks(options, tasks, totals, aggregate) {
  let completedBytes = 0;
  for (const task of tasks) {
    const totalBytes = totals.get(task.destination) || 0;
    await downloadHfFileWithProgress(task, options, {
      totalBytes,
      knownAggregateBytes: aggregate.known ? aggregate.totalBytes : 0,
      completedBytes,
      onComplete: (bytesWritten) => {
        completedBytes += aggregate.known ? totalBytes : bytesWritten;
      },
    });
  }
}

/** @param {ModelAssetOptions} options @param {ReturnType<typeof buildAggregate>} aggregate */
function emitPaddleDownloadComplete(options, aggregate) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 파일 다운로드 완료",
    "모든 Paddle OCR 모델 파일을 로컬 캐시에 저장했습니다.",
    {
      progressMode: aggregate.known ? "determinate" : "log-only",
      progressPercent: aggregate.known ? 1 : undefined,
      progressBytes: aggregate.known ? aggregate.totalBytes : undefined,
      progressTotalBytes: aggregate.known ? aggregate.totalBytes : undefined,
      installLogLine: "Paddle OCR 모델 파일 다운로드가 완료되었습니다.",
    },
  );
}

/** @param {unknown} value */
function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

module.exports = {
  ensurePaddleOcrModelAssetsDownloaded,
  isPaddleOcrModelAssetLoadFailure,
};
