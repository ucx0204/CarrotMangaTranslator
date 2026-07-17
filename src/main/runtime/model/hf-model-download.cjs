// @ts-check
const path = require("node:path");
const {
  downloadHfFileWithProgress,
  isUsableFile,
  mapWithConcurrency,
  probeContentLength,
  resolveDownloadRangeConcurrency,
} = require("../simple-page-download-utils.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
} = require("../simple-page-runtime-common.cjs");
const {
  assertWindowsModelLaunchPaths,
  ensureCompactCachedHfAssets,
  isWindowsLegacyLongPath,
} = require("./compact-model-cache.cjs");
const { collectRequiredHfDownloads } = require("./hf-model-download-tasks.cjs");
const { inspectModelLaunch } = require("./model-launch-target.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */
/** @typedef {ReturnType<typeof inspectModelLaunch>} ModelLaunchTarget */

/** @param {ModelAssetOptions} [options] @param {ModelLaunchTarget} [target] */
async function ensureHfModelAssetsDownloaded(
  options = {},
  target = inspectModelLaunch(options),
) {
  await ensureCompactCachedHfAssets(options, target);
  const refreshed = inspectModelLaunch(options);
  assertWindowsModelLaunchPaths(refreshed);
  const tasks = collectRequiredHfDownloads(options, refreshed).filter(
    (task) => !isUsableFile(task.destination),
  );
  assertSafeDestinations(tasks);
  if (tasks.length === 0) return;
  const totals = await collectDownloadTotals(tasks, options.abortSignal);
  const aggregate = buildAggregate(totals, tasks.length);
  emitModelDownloadStart(options, tasks.length, aggregate);
  await downloadTasks(tasks, options, totals, aggregate);
  assertWindowsModelLaunchPaths(inspectModelLaunch(options));
  emitModelDownloadComplete(options, aggregate);
}

/** @param {Array<{ label: string; destination: string }>} tasks */
function assertSafeDestinations(tasks) {
  const unsafe = tasks.find((task) =>
    isWindowsLegacyLongPath(task.destination),
  );
  if (!unsafe) return;
  throw createDetailedError(
    "Gemma 모델 캐시 루트가 너무 길어 Windows에서 모델을 실행할 수 없습니다.",
    {
      assetLabel: unsafe.label,
      destinationPath: unsafe.destination,
      destinationPathLength: path.resolve(unsafe.destination).length,
    },
  );
}

/** @param {Array<{ url: string; destination: string }>} tasks @param {AbortSignal | null | undefined} signal */
async function collectDownloadTotals(tasks, signal) {
  const totals = new Map();
  const probes = await mapWithConcurrency(
    tasks,
    resolveDownloadRangeConcurrency(),
    async (task) => ({
      task,
      totalBytes: await probeContentLength(task.url, signal),
    }),
  );
  for (const { task, totalBytes } of probes) {
    if (Number.isFinite(totalBytes) && totalBytes > 0)
      totals.set(task.destination, totalBytes);
  }
  return totals;
}

/** @param {Map<string, number>} totals @param {number} taskCount */
function buildAggregate(totals, taskCount) {
  const knownTotalBytes = [...totals.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  return {
    knownTotalBytes,
    known: knownTotalBytes > 0 && totals.size === taskCount,
  };
}

/** @param {ModelAssetOptions} options @param {number} taskCount @param {ReturnType<typeof buildAggregate>} aggregate */
function emitModelDownloadStart(options, taskCount, aggregate) {
  emitRuntimeProgress(
    options,
    "model_downloading",
    "Gemma 모델 다운로드 중",
    `${taskCount}개 파일 준비`,
    {
      progressMode: aggregate.known ? "determinate" : "log-only",
      progressPercent: aggregate.known ? 0 : undefined,
      progressBytes: 0,
      progressTotalBytes: aggregate.known
        ? aggregate.knownTotalBytes
        : undefined,
      installLogLine: `다운로드 대상 ${taskCount}개 파일을 확인했습니다.`,
    },
  );
}

/** @param {ReturnType<typeof collectRequiredHfDownloads>} tasks @param {ModelAssetOptions} options @param {Map<string, number>} totals @param {ReturnType<typeof buildAggregate>} aggregate */
async function downloadTasks(tasks, options, totals, aggregate) {
  let completedBytes = 0;
  for (const task of tasks) {
    const totalBytes = totals.get(task.destination) || 0;
    await downloadHfFileWithProgress(task, options, {
      totalBytes,
      knownAggregateBytes: aggregate.known ? aggregate.knownTotalBytes : 0,
      completedBytes,
      onComplete: (bytesWritten) => {
        completedBytes += aggregate.known ? totalBytes : bytesWritten;
      },
    });
  }
}

/** @param {ModelAssetOptions} options @param {ReturnType<typeof buildAggregate>} aggregate */
function emitModelDownloadComplete(options, aggregate) {
  emitRuntimeProgress(
    options,
    "model_downloading",
    "Gemma 모델 다운로드 완료",
    "모든 모델 파일을 로컬 캐시에 저장했습니다.",
    {
      progressMode: aggregate.known ? "determinate" : "log-only",
      progressPercent: aggregate.known ? 1 : undefined,
      progressBytes: aggregate.known ? aggregate.knownTotalBytes : undefined,
      progressTotalBytes: aggregate.known
        ? aggregate.knownTotalBytes
        : undefined,
      installLogLine: "Gemma 모델 파일 다운로드가 완료되었습니다.",
    },
  );
}

module.exports = { ensureHfModelAssetsDownloaded };
