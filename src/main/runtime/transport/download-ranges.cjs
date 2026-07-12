// @ts-check
/** @typedef {import("../runtime-jsdoc-types").DetailedError} DetailedError */
/** @typedef {{ url: string; file: string; destination: string; label: string; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number }} DownloadProgress */
const { open: fsOpen, rm } = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { HF_DOWNLOAD_CHUNK_SIZE } = require("../simple-page-defaults.cjs");
const {
  createDetailedError,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  createLinkedAbortController,
  isAbortError,
  resolveDownloadRetryCount,
  resolveDownloadStallTimeoutMs,
} = require("./download-primitives.cjs");
const {
  emitDownloadRetryProgress,
  emitHfDownloadProgress,
  emitRangeFallbackProgress,
} = require("./download-progress.cjs");
const { downloadHfFileByStream } = require("./download-stream.cjs");

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
  let receivedBytes = 0;
  let lastEmitAt = 0;
  for (let start = 0; start < totalBytes; start += HF_DOWNLOAD_CHUNK_SIZE) {
    const end = Math.min(totalBytes - 1, start + HF_DOWNLOAD_CHUNK_SIZE - 1);
    const chunk = await fetchRangeForFallback(task, options, start, end);
    assertRangeLength(task, chunk, start, end);
    await file.write(chunk, 0, chunk.length, start);
    receivedBytes += chunk.length;
    const now = Date.now();
    if (now - lastEmitAt > 500 || receivedBytes >= totalBytes) {
      lastEmitAt = now;
      emitRangeProgress(
        options,
        task,
        progress,
        receivedBytes,
        totalBytes,
        startedAt,
      );
    }
  }
  return receivedBytes;
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end */
async function fetchRangeForFallback(task, options, start, end) {
  try {
    return await fetchRangeBufferWithRetry(task, options, start, end);
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
  try {
    return await downloadHfFileByStream(
      task,
      options,
      progress,
      partPath,
      startedAt,
    );
  } catch (error) {
    if (error instanceof Error)
      Object.assign(error, { rangeFallbackFailed: true });
    throw error;
  }
}

/** @param {unknown} error */
function isRangeFallbackCandidate(error) {
  if (!(error instanceof Error)) return false;
  const detail = /** @type {DetailedError} */ (error);
  if (detail.rangeUnsupported === true) return true;
  const status = Number(detail.status);
  if (!Number.isInteger(status)) return true;
  if ([401, 403, 404].includes(status)) return false;
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

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end */
async function fetchRangeBufferWithRetry(task, options, start, end) {
  const maxAttempts = resolveDownloadRetryCount();
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchRangeBuffer(task, options, start, end);
    } catch (error) {
      if (
        options.abortSignal?.aborted ||
        isAbortError(error) ||
        hasRangeUnsupported(error)
      )
        throw error;
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
      await delay(Math.min(30000, 1000 * 2 ** (attempt - 1)), undefined, {
        signal: options.abortSignal ?? undefined,
      });
    }
  }
  throw lastError || createRangeError(task, start, end);
}

/** @param {unknown} error */
function hasRangeUnsupported(error) {
  return (
    error instanceof Error &&
    /** @type {DetailedError} */ (error).rangeUnsupported === true
  );
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

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end */
async function fetchRangeBuffer(task, options, start, end) {
  const range = `bytes=${start}-${end}`;
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  const timeoutState = { timedOut: false };
  const timeout = setTimeout(
    () => abortRangeFetch(linked.controller, timeoutState),
    stallTimeoutMs,
  );
  try {
    const response = await fetch(task.url, {
      headers: { Range: range },
      signal: linked.controller.signal,
    });
    assertRangeResponse(task, response, range);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (timeoutState.timedOut)
      throw buildRangeStallError(task, range, stallTimeoutMs, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

/** @param {AbortController} controller @param {{ timedOut: boolean }} state */
function abortRangeFetch(controller, state) {
  state.timedOut = true;
  controller.abort();
}

/** @param {HfDownloadTask} task @param {Response} response @param {string} range */
function assertRangeResponse(task, response, range) {
  if (response.status === 200) {
    throw createDetailedError(
      `${task.label} 서버가 범위 다운로드를 지원하지 않습니다.`,
      {
        rangeUnsupported: true,
        status: response.status,
        url: task.url,
        file: task.file,
      },
    );
  }
  if (response.status === 206 && response.ok) return;
  throw createDetailedError(
    `${task.label} 다운로드 조각에 실패했습니다 (${response.status}).`,
    {
      status: response.status,
      statusText: response.statusText,
      url: task.url,
      file: task.file,
      range,
    },
  );
}

/** @param {HfDownloadTask} task @param {string} range @param {number} stallTimeoutMs @param {unknown} cause */
function buildRangeStallError(task, range, stallTimeoutMs, cause) {
  return createDetailedError(
    `${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`,
    { url: task.url, file: task.file, range, stallTimeoutMs },
    cause,
  );
}

module.exports = { downloadHfFileByRanges };
