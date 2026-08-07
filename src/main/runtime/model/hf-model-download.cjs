// @ts-check
const path = require("node:path");
const { rm } = require("node:fs/promises");
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
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  integrityMarkerPath,
  normalizeExpectedSha256,
  verifyFileSha256,
} = require("../transport/download-integrity.cjs");
const {
  assertWindowsModelLaunchPaths,
  ensureCompactCachedHfAssets,
  isWindowsLegacyLongPath,
} = require("./compact-model-cache.cjs");
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  shouldUseConfiguredMmproj,
} = require("../simple-page-model-config.cjs");
const {
  collectRequiredHfDownloads,
  resolvePinnedGemmaAsset,
} = require("./hf-model-download-tasks.cjs");
const { inspectModelLaunch } = require("./model-launch-target.cjs");
const { resolveLlamaRuntimeProfile } = require("./runtime-profile.cjs");
const {
  MAX_MODEL_DOWNLOAD_AGGREGATE_BYTES,
} = require("../transport/download-budgets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */
/** @typedef {ReturnType<typeof inspectModelLaunch>} ModelLaunchTarget */

/** @param {ModelAssetOptions} [options] @param {ModelLaunchTarget} [target] */
async function ensureHfModelAssetsDownloaded(
  options = {},
  target = inspectModelLaunch(options),
) {
  await ensureCompactCachedHfAssets(options, target);
  let refreshed = inspectModelLaunch(options);
  await removeInvalidMetalCachedAssets(options, refreshed);
  refreshed = inspectModelLaunch(options);
  assertWindowsModelLaunchPaths(refreshed);
  const tasks = await collectPendingModelTasks(
    collectRequiredHfDownloads(options, refreshed),
    options,
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

/**
 * Apple Silicon Alpha can reuse a pre-existing Hugging Face cache. Verify
 * built-in assets before that cache reaches a Metal process; a corrupt entry
 * is removed so the normal immutable-revision download path replaces it.
 * Custom and explicitly local models do not have a project-owned checksum.
 * @param {ModelAssetOptions} options
 * @param {ModelLaunchTarget} target
 */
async function removeInvalidMetalCachedAssets(options, target) {
  if (resolveLlamaRuntimeProfile(options) !== "metal") return;
  for (const asset of collectCachedPinnedAssets(options, target)) {
    emitRuntimeProgress(
      options,
      "model_downloading",
      "Gemma 모델 체크섬 확인 중",
      asset.file,
      { progressMode: "indeterminate" },
    );
    const result = await verifyFileSha256(asset.filePath, asset.expectedSha256);
    if (result.verified) continue;
    await rm(asset.filePath, { force: true });
    await safeCleanup("remove invalid Gemma integrity marker", () =>
      rm(integrityMarkerPath(asset.filePath), { force: true }),
    );
  }
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target */
function collectCachedPinnedAssets(options, target) {
  if (["openai-codex", "openai-api"].includes(target.launchMode)) return [];
  const candidates = [];
  if (target.launchMode !== "local") {
    candidates.push({
      repo: resolveConfiguredModelRepo(options),
      file: resolveConfiguredModelFile(options),
      filePath: target.modelPath,
    });
    if (shouldUseConfiguredMmproj(options)) {
      candidates.push({
        repo: resolveConfiguredMmprojRepo(options),
        file: resolveConfiguredMmprojFile(options),
        filePath: target.mmprojPath,
      });
    }
  }
  if (options.useDraft) {
    candidates.push({
      repo: resolveConfiguredDraftModelRepo(options),
      file: resolveConfiguredDraftModelFile(options),
      filePath: target.draftModelPath,
    });
  }
  return candidates.flatMap((candidate) => {
    const pin = resolvePinnedGemmaAsset(candidate.repo, candidate.file);
    return pin && candidate.filePath && isUsableFile(candidate.filePath)
      ? [{ ...candidate, ...pin, filePath: candidate.filePath }]
      : [];
  });
}

/** @param {ReturnType<typeof collectRequiredHfDownloads>} tasks @param {ModelAssetOptions} options */
async function collectPendingModelTasks(tasks, options) {
  const pending = [];
  for (const task of tasks) {
    if (!isUsableFile(task.destination)) {
      pending.push(task);
      continue;
    }
    const expected = normalizeExpectedSha256(task.expectedSha256);
    if (!expected) continue;
    emitRuntimeProgress(
      options,
      "model_downloading",
      "Gemma 모델 체크섬 확인 중",
      task.file,
      { progressMode: "indeterminate" },
    );
    const result = await verifyFileSha256(task.destination, expected);
    if (result.verified) continue;
    await safeCleanup("remove checksum-mismatched Gemma model", async () => {
      await rm(task.destination, { force: true });
      await rm(integrityMarkerPath(task.destination), { force: true });
    });
    pending.push(task);
  }
  return pending;
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

/** @param {Array<{ url: string; destination: string; maximumBytes: number }>} tasks @param {AbortSignal | null | undefined} signal */
async function collectDownloadTotals(tasks, signal) {
  const totals = new Map();
  const probes = await mapWithConcurrency(
    tasks,
    resolveDownloadRangeConcurrency(),
    async (task) => ({
      task,
      totalBytes: await probeContentLength(task.url, signal, task.maximumBytes),
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
  let knownTotalBytes = 0;
  for (const value of totals.values()) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      knownTotalBytes > MAX_MODEL_DOWNLOAD_AGGREGATE_BYTES - value
    ) {
      throw createDetailedError(
        "Gemma 모델 다운로드 총 크기가 허용 한도를 초과했습니다.",
        {
          maximumBytes: MAX_MODEL_DOWNLOAD_AGGREGATE_BYTES,
          downloadBudgetExceeded: true,
          nonRetriable: true,
        },
      );
    }
    knownTotalBytes += value;
  }
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

module.exports = {
  ensureHfModelAssetsDownloaded,
  removeInvalidMetalCachedAssets,
};
