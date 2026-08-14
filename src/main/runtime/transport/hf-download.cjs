// @ts-check
/** @typedef {{ url: string; file: string; destination: string; label: string; maximumBytes: number; minimumBytes?: number; expectedTotalBytes?: number; expectedSha256?: string; progressPhase?: string; progressTitle?: string; completeTitle?: string; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number; onComplete?: (receivedBytes: number) => void }} DownloadProgress */
/** @typedef {Readonly<{ receivedBytes: number; verifiedSha256: string | null; size: number; mtimeMs: number }>} DownloadCompletionReceipt */
const { mkdir, rename, rm, stat } = require("node:fs/promises");
const path = require("node:path");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  createAbortError,
  createDownloadDeadline,
  isAbortError,
  isDownloadBudgetError,
  isDownloadDeadlineError,
  isNonRetryableDownloadFileError,
  isNonRetryableDownloadHttpError,
  resolveDownloadAbsoluteTimeoutMs,
  resolveDownloadRetryCount,
  resolveDownloadRetryDelayMs,
} = require("./download-primitives.cjs");
const {
  assertCompatibleActiveDownload,
  assertReceiptMatchesTask,
  assertReceivedSize,
  validateDownloadContract,
} = require("./download-contract.cjs");
const {
  emitDownloadRetryProgress,
  emitHfDownloadProgress,
  resolveDownloadProgressTitle,
} = require("./download-progress.cjs");
const { downloadHfFileByRanges } = require("./download-ranges.cjs");
const { downloadHfFileByStream } = require("./download-stream.cjs");
const {
  calculateFileSha256,
  normalizeExpectedSha256,
  writeIntegrityMarker,
} = require("./download-integrity.cjs");
const { waitForDownloadRetry } = require("./download-retry-wait.cjs");

/** @type {Map<string, { url: string; maximumBytes: number; expectedSha256: string | null; expectedTotalBytes: number | null; minimumBytes: number | null; promise: Promise<DownloadCompletionReceipt> }>} */
const activeDownloads = new Map();
const COMMIT_RETRY_COUNT = 6;
const RETRYABLE_COMMIT_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

/** @param {HfDownloadTask} task @param {DownloadOptions} [options] @param {DownloadProgress} [progress] */
async function downloadHfFileWithProgress(task, options = {}, progress = {}) {
  const contract = validateDownloadContract(task, progress);
  const key = downloadKey(task.destination);
  const active = activeDownloads.get(key);
  if (active) {
    assertCompatibleActiveDownload(active, task, contract);
    const startedAt = Date.now();
    const receipt = await waitForActiveDownload(
      active.promise,
      options.abortSignal,
    );
    assertReceiptMatchesTask(task, contract, receipt);
    completeDownload(task, options, progress, receipt.receivedBytes, startedAt);
    return receipt;
  }
  const download = performDownloadWithProgress(task, options, progress);
  const activeEntry = {
    url: task.url,
    maximumBytes: task.maximumBytes,
    ...contract,
    promise: download,
  };
  activeDownloads.set(key, activeEntry);
  try {
    return await download;
  } finally {
    if (activeDownloads.get(key) === activeEntry) activeDownloads.delete(key);
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @returns {Promise<DownloadCompletionReceipt>} */
async function performDownloadWithProgress(task, options, progress) {
  const timeoutMs = resolveDownloadAbsoluteTimeoutMs(options);
  const deadline = createDownloadDeadline(options.abortSignal, timeoutMs, task);
  const boundedOptions = { ...options, abortSignal: deadline.signal };
  try {
    return await performDownloadRetries(task, boundedOptions, progress);
  } catch (error) {
    if (deadline.didTimeOut() && deadline.signal.reason instanceof Error) {
      throw deadline.signal.reason;
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @returns {Promise<DownloadCompletionReceipt>} */
async function performDownloadRetries(task, options, progress) {
  const maxAttempts = resolveDownloadRetryCount();
  const fallbackState = { used: false };
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await downloadAttempt(
        task,
        options,
        progress,
        attempt,
        maxAttempts,
        fallbackState,
      );
    } catch (error) {
      if (
        options.abortSignal?.aborted ||
        isAbortError(error) ||
        isDownloadBudgetError(error) ||
        isDownloadDeadlineError(error) ||
        isNonRetryableDownloadFileError(error) ||
        isNonRetryableDownloadHttpError(error)
      )
        throw error;
      lastError = error;
      if (attempt >= maxAttempts) break;
      emitDownloadRetryProgress(options, task, error, attempt + 1, maxAttempts);
      await retryDelay(attempt, error, options.abortSignal);
    }
  }
  throw (
    lastError ||
    createDetailedError(`${task.label} 다운로드에 실패했습니다.`, {
      file: task.file,
    })
  );
}

/** @param {string} destination */
function downloadKey(destination) {
  const resolved = path.resolve(destination);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** @param {Promise<DownloadCompletionReceipt>} download @param {AbortSignal | null | undefined} signal */
function waitForActiveDownload(download, signal) {
  if (!signal) return download;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    download.then(
      (receipt) => {
        cleanup();
        resolve(receipt);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** @param {number} attempt @param {unknown} error @param {AbortSignal | null | undefined} signal */
function retryDelay(attempt, error, signal) {
  return waitForDownloadRetry(
    resolveDownloadRetryDelayMs(attempt, error),
    signal,
  );
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {number} attempt @param {number} maxAttempts @param {{ used: boolean }} fallbackState */
async function downloadAttempt(
  task,
  options,
  progress,
  attempt,
  maxAttempts,
  fallbackState,
) {
  const partPath = `${task.destination}.part`;
  let committedDownload = false;
  await mkdir(path.dirname(task.destination), { recursive: true });
  await rm(partPath, { force: true });
  emitDownloadStart(task, options, progress, attempt, maxAttempts);
  const startedAt = Date.now();
  try {
    const receivedBytes = await transferFile(
      task,
      options,
      progress,
      partPath,
      startedAt,
      fallbackState,
    );
    assertReceivedSize(task, receivedBytes);
    const verifiedSha256 = await assertDownloadIntegrity(task, partPath);
    await commitDownload(task.destination, partPath);
    committedDownload = true;
    await recordDownloadIntegrity(task, verifiedSha256);
    const committed = await stat(task.destination);
    if (!committed.isFile() || committed.size !== receivedBytes) {
      throw createDetailedError(
        `${task.label} 다운로드의 최종 파일 크기가 전송 결과와 다릅니다.`,
        {
          destination: task.destination,
          receivedBytes,
          committedBytes: committed.size,
        },
      );
    }
    const receipt = Object.freeze({
      receivedBytes,
      verifiedSha256,
      size: committed.size,
      mtimeMs: committed.mtimeMs,
    });
    completeDownload(task, options, progress, receivedBytes, startedAt);
    return receipt;
  } catch (error) {
    if (committedDownload) {
      await removeRejectedCommittedDownload(task.destination);
    }
    if (!isDownloadCommitFailure(error)) {
      await safeCleanup("remove partial HF download", () =>
        rm(partPath, { force: true }),
      );
    }
    throw error;
  }
}

/** @param {string} destination */
async function removeRejectedCommittedDownload(destination) {
  await safeCleanup("remove rejected committed HF download", () =>
    Promise.all([
      rm(destination, { force: true }),
      rm(`${destination}.mgtmeta.json`, { force: true }),
      rm(`${destination}.mgt-sha256.json`, { force: true }),
    ]).then(() => undefined),
  );
}

/** @param {HfDownloadTask} task @param {string} partPath */
async function assertDownloadIntegrity(task, partPath) {
  const expected = normalizeExpectedSha256(task.expectedSha256);
  if (!expected) return null;
  const actual = await calculateFileSha256(partPath);
  if (actual === expected) return actual;
  throw createDetailedError(
    `${task.label} 다운로드 체크섬이 일치하지 않습니다.`,
    {
      file: task.file,
      url: task.url,
      expectedSha256: expected,
      actualSha256: actual,
    },
  );
}

/** @param {HfDownloadTask} task @param {string | null} verifiedSha256 */
async function recordDownloadIntegrity(task, verifiedSha256) {
  if (verifiedSha256) {
    await writeIntegrityMarker(task.destination, verifiedSha256);
  }
}

/** @param {unknown} error */
function isDownloadCommitFailure(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {{ downloadCommitFailed?: unknown }} */ (error)
      .downloadCommitFailed === true,
  );
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {number} attempt @param {number} maxAttempts */
function emitDownloadStart(task, options, progress, attempt, maxAttempts) {
  const state = initialProgressState(progress);
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      ...state,
      installLogLine: initialDownloadLogLine(task, attempt, maxAttempts),
    },
  );
}

/** @param {DownloadProgress} progress */
function initialProgressState(progress) {
  const aggregate = progress.knownAggregateBytes || 0;
  const total = progress.totalBytes || 0;
  if (aggregate) {
    return {
      progressMode: "determinate",
      progressPercent: (progress.completedBytes || 0) / aggregate,
      progressBytes: progress.completedBytes || 0,
      progressTotalBytes: aggregate,
    };
  }
  return {
    progressMode: total ? "determinate" : "log-only",
    progressPercent: total ? 0 : undefined,
    progressBytes: total ? 0 : undefined,
    progressTotalBytes: total || undefined,
  };
}

/** @param {HfDownloadTask} task @param {number} attempt @param {number} maxAttempts */
function initialDownloadLogLine(task, attempt, maxAttempts) {
  return attempt > 1
    ? `${task.label} 다운로드 재시도 ${attempt}/${maxAttempts}: ${task.file}`
    : `${task.label} 다운로드 시작: ${task.file}`;
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {string} partPath @param {number} startedAt @param {{ used: boolean }} fallbackState */
function transferFile(
  task,
  options,
  progress,
  partPath,
  startedAt,
  fallbackState,
) {
  const totalBytes = progress.totalBytes || task.expectedTotalBytes || 0;
  return totalBytes > 0 && !fallbackState.used
    ? downloadHfFileByRanges(
        task,
        options,
        progress,
        partPath,
        totalBytes,
        startedAt,
        fallbackState,
      )
    : downloadHfFileByStream(task, options, progress, partPath, startedAt);
}

/** @param {string} destination @param {string} partPath */
async function commitDownload(destination, partPath) {
  try {
    await retryCommitOperation(() => rm(destination, { force: true }));
    await retryCommitOperation(() => rename(partPath, destination));
  } catch (error) {
    if (error && typeof error === "object") {
      Object.assign(error, { downloadCommitFailed: true });
      throw error;
    }
    throw createDetailedError(
      "다운로드 파일을 최종 경로로 옮기지 못했습니다.",
      {
        destination,
        partPath,
        downloadCommitFailed: true,
        originalError: error,
      },
    );
  }
}

/** @param {() => Promise<unknown>} operation */
async function retryCommitOperation(operation) {
  let lastError = null;
  for (let attempt = 1; attempt <= COMMIT_RETRY_COUNT; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableCommitError(error) || attempt >= COMMIT_RETRY_COUNT)
        throw error;
      await waitForDownloadRetry(Math.min(1000, 50 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** @param {unknown} error */
function isRetryableCommitError(error) {
  if (!error || typeof error !== "object") return false;
  const code = String(/** @type {{ code?: unknown }} */ (error).code ?? "");
  return RETRYABLE_COMMIT_CODES.has(code.toUpperCase());
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {number} receivedBytes @param {number} startedAt */
function completeDownload(task, options, progress, receivedBytes, startedAt) {
  try {
    progress.onComplete?.(receivedBytes);
  } catch (_error) {
    // error-policy-allow: observer failures must never turn a completed download into a retry.
  }
  emitHfDownloadProgress(options, task, {
    receivedBytes,
    totalBytes: progress.totalBytes || 0,
    knownAggregateBytes: progress.knownAggregateBytes || 0,
    aggregateCompletedBytes: progress.completedBytes || 0,
    startedAt,
    completed: true,
  });
}

module.exports = { downloadHfFileWithProgress };
