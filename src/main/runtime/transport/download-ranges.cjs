// @ts-check
/** @typedef {import("../runtime-jsdoc-types").DetailedError} DetailedError */
/** @typedef {{ url: string; file: string; destination: string; label: string; maximumBytes: number; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number }} DownloadProgress */
/** @typedef {{ header: "etag" | "last-modified"; value: string }} RangeValidator */
const { open: fsOpen, rm } = require("node:fs/promises");
const {
  createDetailedError,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  assertDownloadSizeWithinBudget,
  createLinkedAbortController,
  isAbortError,
  isDownloadBudgetError,
  isDownloadDeadlineError,
  isNonRetryableDownloadHttpError,
  resolveDownloadChunkSize,
  resolveDownloadRangeConcurrency,
  resolveDownloadRetryCount,
  resolveDownloadRetryDelayMs,
} = require("./download-primitives.cjs");
const { fetchRangeBuffer } = require("./download-range-request.cjs");
const {
  emitDownloadRetryProgress,
  emitHfDownloadProgress,
  emitRangeFallbackProgress,
} = require("./download-progress.cjs");
const { downloadHfFileByStream } = require("./download-stream.cjs");
const { waitForDownloadRetry } = require("./download-retry-wait.cjs");

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {string} partPath @param {number} totalBytes @param {number} startedAt @param {{ used: boolean }} fallbackState */
async function downloadHfFileByRanges(
  task,
  options,
  progress,
  partPath,
  totalBytes,
  startedAt,
  fallbackState,
) {
  assertDownloadSizeWithinBudget(task, totalBytes);
  /** @type {import("node:fs/promises").FileHandle | null} */
  let file = await fsOpen(partPath, "w");
  try {
    await file.truncate(totalBytes);
    return await writeRanges(
      task,
      options,
      progress,
      file,
      totalBytes,
      startedAt,
    );
  } catch (error) {
    if (!shouldFallback(error, options, fallbackState)) throw error;
    fallbackState.used = true;
    await file.close();
    file = null;
    return await fallbackToStream(
      task,
      options,
      progress,
      partPath,
      startedAt,
      error,
    );
  } finally {
    const openFile = file;
    if (openFile) {
      await safeCleanup("close ranged HF download file", () =>
        openFile.close(),
      );
    }
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {import("node:fs/promises").FileHandle} file @param {number} totalBytes @param {number} startedAt */
async function writeRanges(
  task,
  options,
  progress,
  file,
  totalBytes,
  startedAt,
) {
  const chunkSize = resolveDownloadChunkSize();
  const rangeCount = Math.ceil(totalBytes / chunkSize);
  const concurrency = Math.min(rangeCount, resolveDownloadRangeConcurrency());
  const linked = createLinkedAbortController(options.abortSignal);
  const workerOptions = { ...options, abortSignal: linked.controller.signal };
  const state = {
    nextRange: 1,
    receivedBytes: 0,
    lastEmitAt: 0,
    error: /** @type {unknown} */ (null),
    writeTail: Promise.resolve(),
  };
  try {
    const firstEnd = Math.min(totalBytes - 1, chunkSize - 1);
    const firstRange = await fetchRangeForFallback(
      task,
      workerOptions,
      0,
      firstEnd,
      totalBytes,
      null,
    );
    await queueRangeWrite(
      task,
      workerOptions,
      progress,
      file,
      firstRange.buffer,
      0,
      totalBytes,
      startedAt,
      state,
    );
    const remainingRanges = rangeCount - 1;
    if (remainingRanges === 0) return state.receivedBytes;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, remainingRanges) }, () =>
        downloadRangeWorker(
          task,
          workerOptions,
          progress,
          file,
          totalBytes,
          chunkSize,
          firstRange.validator,
          startedAt,
          state,
          linked.controller,
        ),
      ),
    );
    await state.writeTail;
    if (state.error) throw state.error;
    return state.receivedBytes;
  } finally {
    linked.cleanup();
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {import("node:fs/promises").FileHandle} file @param {number} totalBytes @param {number} chunkSize @param {RangeValidator | null} validator @param {number} startedAt @param {{ nextRange: number; receivedBytes: number; lastEmitAt: number; error: unknown; writeTail: Promise<void> }} state @param {AbortController} controller */
async function downloadRangeWorker(
  task,
  options,
  progress,
  file,
  totalBytes,
  chunkSize,
  validator,
  startedAt,
  state,
  controller,
) {
  while (!state.error) {
    const rangeIndex = state.nextRange;
    state.nextRange += 1;
    const start = rangeIndex * chunkSize;
    if (start >= totalBytes) return;
    const end = Math.min(totalBytes - 1, start + chunkSize - 1);
    try {
      const chunk = await fetchRangeForFallback(
        task,
        options,
        start,
        end,
        totalBytes,
        validator,
      );
      if (state.error) return;
      await queueRangeWrite(
        task,
        options,
        progress,
        file,
        chunk.buffer,
        start,
        totalBytes,
        startedAt,
        state,
      );
    } catch (error) {
      if (!state.error) {
        state.error = error;
        controller.abort();
      }
      return;
    }
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {import("node:fs/promises").FileHandle} file @param {Buffer} chunk @param {number} start @param {number} totalBytes @param {number} startedAt @param {{ receivedBytes: number; lastEmitAt: number; error: unknown; writeTail: Promise<void> }} state */
function queueRangeWrite(
  task,
  options,
  progress,
  file,
  chunk,
  start,
  totalBytes,
  startedAt,
  state,
) {
  const write = state.writeTail.then(async () => {
    if (state.error) return;
    const result = await file.write(chunk, 0, chunk.length, start);
    if (result.bytesWritten !== chunk.length) {
      throw createDetailedError(
        `${task.label} 다운로드 조각을 파일에 모두 쓰지 못했습니다.`,
        {
          fileWriteFailed: true,
          url: task.url,
          file: task.file,
          rangeStart: start,
          expectedLength: chunk.length,
          writtenLength: result.bytesWritten,
        },
      );
    }
    state.receivedBytes += chunk.length;
    const now = Date.now();
    if (now - state.lastEmitAt > 500 || state.receivedBytes >= totalBytes) {
      state.lastEmitAt = now;
      emitRangeProgress(
        options,
        task,
        progress,
        state.receivedBytes,
        totalBytes,
        startedAt,
      );
    }
  });
  state.writeTail = write;
  return write;
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end @param {number} totalBytes @param {RangeValidator | null} validator */
async function fetchRangeForFallback(
  task,
  options,
  start,
  end,
  totalBytes,
  validator,
) {
  try {
    const chunk = await fetchRangeBufferWithRetry(
      task,
      options,
      start,
      end,
      totalBytes,
      validator,
    );
    assertRangeLength(task, chunk.buffer, start, end);
    return chunk;
  } catch (error) {
    if (error instanceof Error)
      Object.assign(error, { rangedFetchFailed: true });
    throw error;
  }
}

/** @param {unknown} error @param {DownloadOptions} options @param {{ used: boolean }} state */
function shouldFallback(error, options, state) {
  return Boolean(
    error instanceof Error &&
    /** @type {DetailedError & { rangedFetchFailed?: boolean }} */ (error)
      .rangedFetchFailed === true &&
    !state.used &&
    !options.abortSignal?.aborted &&
    !isAbortError(error) &&
    !isDownloadBudgetError(error) &&
    !isDownloadDeadlineError(error) &&
    isRangeFallbackCandidate(error),
  );
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {string} partPath @param {number} startedAt @param {unknown} rangeError */
async function fallbackToStream(
  task,
  options,
  progress,
  partPath,
  startedAt,
  rangeError,
) {
  await safeCleanup("remove partial ranged HF download", () =>
    rm(partPath, { force: true }),
  );
  emitRangeFallbackProgress(options, task, rangeError);
  return await downloadHfFileByStream(
    task,
    options,
    progress,
    partPath,
    startedAt,
  );
}

/** @param {unknown} error */
function isRangeFallbackCandidate(error) {
  if (!(error instanceof Error)) return false;
  const detail = /** @type {DetailedError} */ (error);
  if (detail.rangeUnsupported === true) return true;
  if (detail.rangeInvalid === true) return true;
  const status = Number(detail.status);
  if (!Number.isInteger(status)) return true;
  if ([401, 403, 404, 407].includes(status)) return false;
  return status === 416 || status === 429 || status >= 500 || status !== 206;
}

/** @param {HfDownloadTask} task @param {Buffer} chunk @param {number} start @param {number} end */
function assertRangeLength(task, chunk, start, end) {
  const expectedLength = end - start + 1;
  if (chunk.length === expectedLength) return;
  throw createDetailedError(
    `${task.label} 다운로드 조각 크기가 올바르지 않습니다.`,
    {
      url: task.url,
      file: task.file,
      rangeStart: start,
      rangeEnd: end,
      expectedLength,
      receivedLength: chunk.length,
    },
  );
}

/** @param {DownloadOptions} options @param {HfDownloadTask} task @param {DownloadProgress} progress @param {number} receivedBytes @param {number} totalBytes @param {number} startedAt */
function emitRangeProgress(
  options,
  task,
  progress,
  receivedBytes,
  totalBytes,
  startedAt,
) {
  emitHfDownloadProgress(options, task, {
    receivedBytes,
    totalBytes,
    knownAggregateBytes: progress.knownAggregateBytes || 0,
    aggregateCompletedBytes: progress.completedBytes || 0,
    startedAt,
  });
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end @param {number} totalBytes @param {RangeValidator | null} validator */
async function fetchRangeBufferWithRetry(
  task,
  options,
  start,
  end,
  totalBytes,
  validator,
) {
  const maxAttempts = resolveDownloadRetryCount();
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchRangeBuffer(
        task,
        options,
        start,
        end,
        totalBytes,
        validator,
      );
    } catch (error) {
      if (isNonRetryableRangeFailure(options, error)) throw error;
      lastError = error;
      if (attempt >= maxAttempts) break;
      emitDownloadRetryProgress(
        options,
        task,
        error,
        attempt + 1,
        maxAttempts,
        `bytes=${start}-${end}`,
      );
      await waitForDownloadRetry(
        resolveDownloadRetryDelayMs(attempt, error),
        options.abortSignal,
      );
    }
  }
  throw lastError || createRangeError(task, start, end);
}

/** @param {DownloadOptions} options @param {unknown} error */
function isNonRetryableRangeFailure(options, error) {
  return Boolean(
    options.abortSignal?.aborted ||
    isAbortError(error) ||
    isDownloadBudgetError(error) ||
    isDownloadDeadlineError(error) ||
    isNonRetryableDownloadHttpError(error) ||
    hasRangeProtocolError(error),
  );
}

/** @param {unknown} error */
function hasRangeProtocolError(error) {
  if (!(error instanceof Error)) return false;
  const detail = /** @type {DetailedError} */ (error);
  return detail.rangeUnsupported === true || detail.rangeInvalid === true;
}

/** @param {HfDownloadTask} task @param {number} start @param {number} end */
function createRangeError(task, start, end) {
  return createDetailedError(`${task.label} 다운로드 조각에 실패했습니다.`, {
    url: task.url,
    file: task.file,
    rangeStart: start,
    rangeEnd: end,
  });
}

module.exports = { downloadHfFileByRanges };
