// @ts-check
/** @typedef {import("./runtime-jsdoc-types").DetailedError} DetailedError */
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {{ url: string; file: string; destination: string; label: string; progressPhase?: string; progressTitle?: string; completeTitle?: string; [key: string]: unknown }} HfDownloadTask
 * @typedef {RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions
 * @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number; onComplete?: (receivedBytes: number) => void }} DownloadProgress
 * @typedef {{ used: boolean }} RangeFallbackState
 * @typedef {{ attempt?: number; maxAttempts?: number; rangeFallbackState?: RangeFallbackState }} DownloadAttemptState
 * @typedef {{ receivedBytes: number; totalBytes?: number; knownAggregateBytes?: number; aggregateCompletedBytes?: number; startedAt: number; completed?: boolean }} HfDownloadProgressState
 */
const { createWriteStream, statSync } = require("node:fs");
const { mkdir, open: fsOpen, rename, rm } = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const {
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  HF_DOWNLOAD_CHUNK_SIZE,
} = require("./simple-page-defaults.cjs");
const { formatBytes } = require("./simple-page-progress.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("./simple-page-runtime-common.cjs");

/**
 * @param {unknown} value
 * @returns {number}
 */
function readPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

/**
 * @returns {Error}
 */
function createAbortError() {
  const error = new Error("작업이 취소되었습니다.");
  error.name = "AbortError";
  return error;
}

/**
 * @param {unknown} endpoint
 * @param {string} repo
 * @param {unknown} file
 * @returns {string}
 */
function buildHfResolveUrl(endpoint, repo, file) {
  const filePath = String(file ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${String(endpoint || "https://huggingface.co").replace(/\/+$/, "")}/${repo}/resolve/main/${filePath}`;
}

/**
 * @param {string} filePath
 * @returns {number}
 */
function getFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch (_error) {
    return 0;
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isUsableFile(filePath) {
  try {
    const stats = statSync(filePath);
    return Boolean(filePath) && stats.isFile() && stats.size > 0;
  } catch (_error) {
    return false;
  }
}

/**
 * @param {string} url
 * @param {AbortSignal | null | undefined} signal
 * @returns {Promise<number>}
 */
async function probeContentLength(url, signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const timeoutMs =
    readPositiveInteger(
      process.env.MANGA_TRANSLATOR_DOWNLOAD_METADATA_TIMEOUT_MS,
    ) || DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS;
  const linked = createLinkedAbortController(signal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    linked.controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: linked.controller.signal,
    });
    if (!response.ok) {
      return 0;
    }
    return readContentLength(response);
  } catch (_error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      return 0;
    }
    return 0;
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

/**
 * @returns {number}
 */
function resolveDownloadRetryCount() {
  return (
    readPositiveInteger(
      process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT ??
        process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRIES,
    ) || DEFAULT_DOWNLOAD_RETRY_COUNT
  );
}

/**
 * @returns {number}
 */
function resolveDownloadStallTimeoutMs() {
  return (
    readPositiveInteger(
      process.env.MANGA_TRANSLATOR_DOWNLOAD_STALL_TIMEOUT_MS,
    ) || DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS
  );
}

/**
 * @param {AbortSignal | null | undefined} parentSignal
 * @returns {{ controller: AbortController; cleanup: () => void }}
 */
function createLinkedAbortController(parentSignal) {
  const controller = new AbortController();
  if (parentSignal?.aborted) {
    controller.abort();
    return { controller, cleanup: () => {} };
  }
  const onAbort = () => controller.abort();
  parentSignal?.addEventListener?.("abort", onAbort, { once: true });
  return {
    controller,
    cleanup: () => parentSignal?.removeEventListener?.("abort", onAbort),
  };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {{ name?: unknown }} */ (error).name === "AbortError",
  );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function hasRangeUnsupported(error) {
  return (
    error instanceof Error &&
    /** @type {DetailedError} */ (error).rangeUnsupported === true
  );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function hasRangeFallbackFailed(error) {
  return (
    error instanceof Error &&
    /** @type {DetailedError} */ (error).rangeFallbackFailed === true
  );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isRangeFallbackCandidate(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (hasRangeUnsupported(error)) {
    return true;
  }
  const detail = /** @type {DetailedError} */ (error);
  const status = Number(detail.status);
  if (Number.isInteger(status)) {
    if (status === 401 || status === 403 || status === 404) {
      return false;
    }
    return status === 416 || status === 429 || status >= 500 || status !== 206;
  }
  if (Number.isFinite(Number(detail.stallTimeoutMs))) {
    return true;
  }
  return true;
}

/**
 * @param {unknown} error
 */
function markRangeFallbackFailed(error) {
  if (error instanceof Error) {
    Object.assign(error, { rangeFallbackFailed: true });
  }
  return error;
}

/**
 * @param {Response} response
 * @returns {number}
 */
function readContentLength(response) {
  const value = Number(response.headers?.get?.("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * @param {import("node:fs").WriteStream} writer
 * @param {Uint8Array | Buffer} chunk
 * @returns {Promise<void>}
 */
function writeStreamChunk(writer, chunk) {
  return new Promise((resolve, reject) => {
    /** @param {unknown} error */
    const onError = (error) => {
      writer.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      writer.off("error", onError);
      resolve();
    };
    writer.once("error", onError);
    if (writer.write(chunk)) {
      writer.off("error", onError);
      resolve();
      return;
    }
    writer.once("drain", onDrain);
  });
}

/**
 * @param {import("node:fs").WriteStream} writer
 * @returns {Promise<void>}
 */
function finishWriteStream(writer) {
  return new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(resolve);
  });
}

/**
 * @param {HfDownloadTask} task
 * @param {DownloadOptions} [options]
 * @param {DownloadProgress} [progress]
 * @returns {Promise<void>}
 */
async function downloadHfFileWithProgress(
  task,
  options = /** @type {DownloadOptions} */ ({}),
  progress = /** @type {DownloadProgress} */ ({}),
) {
  const maxAttempts = resolveDownloadRetryCount();
  let lastError = null;
  const rangeFallbackState = { used: false };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await downloadHfFileWithProgressAttempt(task, options, progress, {
        attempt,
        maxAttempts,
        rangeFallbackState,
      });
    } catch (error) {
      if (options.abortSignal?.aborted || isAbortError(error)) {
        throw error;
      }
      lastError = error;
      if (hasRangeFallbackFailed(error)) {
        break;
      }
      if (attempt >= maxAttempts) {
        break;
      }
      emitDownloadRetryProgress(options, task, error, attempt + 1, maxAttempts);
      await delay(Math.min(30000, 1000 * 2 ** (attempt - 1)), undefined, {
        signal: options.abortSignal ?? undefined,
      });
    }
  }
  throw (
    lastError ||
    createDetailedError(`${task.label} 다운로드에 실패했습니다.`, {
      url: task.url,
      file: task.file,
    })
  );
}

/**
 * @param {HfDownloadTask} task
 * @param {DownloadOptions} [options]
 * @param {DownloadProgress} [progress]
 * @param {DownloadAttemptState} [attemptState]
 * @returns {Promise<void>}
 */
async function downloadHfFileWithProgressAttempt(
  task,
  options = /** @type {DownloadOptions} */ ({}),
  progress = /** @type {DownloadProgress} */ ({}),
  attemptState = /** @type {DownloadAttemptState} */ ({}),
) {
  const partPath = `${task.destination}.part`;
  await mkdir(pathDirname(task.destination), { recursive: true });
  await rm(partPath, { force: true });
  const attempt = attemptState.attempt || 1;
  const maxAttempts = attemptState.maxAttempts || 1;

  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      progressMode:
        progress.knownAggregateBytes || progress.totalBytes
          ? "determinate"
          : "log-only",
      progressPercent: progress.knownAggregateBytes
        ? (progress.completedBytes || 0) / progress.knownAggregateBytes
        : progress.totalBytes
          ? 0
          : undefined,
      progressBytes: progress.knownAggregateBytes
        ? progress.completedBytes || 0
        : progress.totalBytes
          ? 0
          : undefined,
      progressTotalBytes:
        progress.knownAggregateBytes || progress.totalBytes || undefined,
      installLogLine:
        attempt > 1
          ? `${task.label} 다운로드 재시도 ${attempt}/${maxAttempts}: ${task.file}`
          : `${task.label} 다운로드 시작: ${task.file}`,
    },
  );

  const startedAt = Date.now();
  const totalBytes = progress.totalBytes || 0;
  const rangeFallbackState =
    attemptState.rangeFallbackState ||
    /** @type {{ used: boolean }} */ ({
      used: false,
    });

  try {
    const receivedBytes =
      totalBytes > 0
        ? await downloadHfFileByRanges(
            task,
            options,
            progress,
            partPath,
            totalBytes,
            startedAt,
            rangeFallbackState,
          )
        : await downloadHfFileByStream(
            task,
            options,
            progress,
            partPath,
            startedAt,
          );
    await rm(task.destination, { force: true });
    await rename(partPath, task.destination);
    progress.onComplete?.(receivedBytes);
    emitHfDownloadProgress(options, task, {
      receivedBytes,
      totalBytes,
      knownAggregateBytes: progress.knownAggregateBytes || 0,
      aggregateCompletedBytes: progress.completedBytes || 0,
      startedAt,
      completed: true,
    });
  } catch (error) {
    await safeCleanup("remove partial HF download", () =>
      rm(partPath, { force: true }),
    );
    throw error;
  }
}

/**
 * @param {HfDownloadTask} task
 * @param {DownloadOptions} options
 * @param {DownloadProgress} progress
 * @param {string} partPath
 * @param {number} totalBytes
 * @param {number} startedAt
 * @param {RangeFallbackState} rangeFallbackState
 * @returns {Promise<number>}
 */
async function downloadHfFileByRanges(
  task,
  options,
  progress,
  partPath,
  totalBytes,
  startedAt,
  rangeFallbackState,
) {
  /** @type {import("node:fs/promises").FileHandle | null} */
  let file = null;
  try {
    file = await fsOpen(partPath, "w");
    await file.truncate(totalBytes);
    const knownAggregateBytes = progress.knownAggregateBytes || 0;
    let receivedBytes = 0;
    let lastEmitAt = 0;

    for (let start = 0; start < totalBytes; start += HF_DOWNLOAD_CHUNK_SIZE) {
      const end = Math.min(totalBytes - 1, start + HF_DOWNLOAD_CHUNK_SIZE - 1);
      let chunk = null;
      try {
        chunk = await fetchRangeBufferWithRetry(task, options, start, end);
      } catch (error) {
        if (
          !rangeFallbackState.used &&
          !options.abortSignal?.aborted &&
          !isAbortError(error) &&
          isRangeFallbackCandidate(error)
        ) {
          rangeFallbackState.used = true;
          await file.close();
          file = null;
          await safeCleanup("remove partial ranged HF download", () =>
            rm(partPath, { force: true }),
          );
          emitRangeFallbackProgress(options, task, error);
          try {
            return await downloadHfFileByStream(
              task,
              options,
              progress,
              partPath,
              startedAt,
            );
          } catch (fallbackError) {
            throw markRangeFallbackFailed(fallbackError);
          }
        }
        throw error;
      }
      const expectedLength = end - start + 1;
      if (chunk.length !== expectedLength) {
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
      await file.write(chunk, 0, chunk.length, start);
      receivedBytes += chunk.length;
      const now = Date.now();
      if (now - lastEmitAt > 500 || receivedBytes >= totalBytes) {
        lastEmitAt = now;
        emitHfDownloadProgress(options, task, {
          receivedBytes,
          totalBytes,
          knownAggregateBytes,
          aggregateCompletedBytes: progress.completedBytes || 0,
          startedAt,
        });
      }
    }
    return receivedBytes;
  } finally {
    const openFile = file;
    if (openFile) {
      await safeCleanup("close ranged HF download file", () =>
        openFile.close(),
      );
    }
  }
}

/**
 * @param {HfDownloadTask} task
 * @param {DownloadOptions} options
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Buffer>}
 */
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
      ) {
        throw error;
      }
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
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
  throw (
    lastError ||
    createDetailedError(`${task.label} 다운로드 조각에 실패했습니다.`, {
      url: task.url,
      file: task.file,
      rangeStart: start,
      rangeEnd: end,
    })
  );
}

/**
 * @param {HfDownloadTask} task
 * @param {DownloadOptions} options
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Buffer>}
 */
async function fetchRangeBuffer(task, options, start, end) {
  const range = `bytes=${start}-${end}`;
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    linked.controller.abort();
  }, stallTimeoutMs);
  try {
    const response = await fetch(task.url, {
      headers: { Range: range },
      signal: linked.controller.signal,
    });
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
    if (response.status !== 206 || !response.ok) {
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
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (timedOut) {
      throw createDetailedError(
        `${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`,
        {
          url: task.url,
          file: task.file,
          range,
          stallTimeoutMs,
        },
        error,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

/**
 * @param {HfDownloadTask} task
 * @param {DownloadOptions} options
 * @param {DownloadProgress} progress
 * @param {string} partPath
 * @param {number} startedAt
 * @returns {Promise<number>}
 */
async function downloadHfFileByStream(
  task,
  options,
  progress,
  partPath,
  startedAt,
) {
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  let timedOut = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  const resetTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timedOut = true;
      linked.controller.abort();
    }, stallTimeoutMs);
  };
  resetTimeout();

  const writer = createWriteStream(partPath, { flags: "wx" });
  try {
    const response = await fetch(task.url, {
      signal: linked.controller.signal,
    });
    if (!response.ok || !response.body) {
      throw createDetailedError(
        `${task.label} 다운로드에 실패했습니다 (${response.status}).`,
        {
          status: response.status,
          statusText: response.statusText,
          url: task.url,
          file: task.file,
        },
      );
    }

    const totalBytes = progress.totalBytes || readContentLength(response);
    const knownAggregateBytes = progress.knownAggregateBytes || 0;
    const reader = response.body.getReader();
    let receivedBytes = 0;
    let lastEmitAt = 0;

    while (true) {
      if (options.abortSignal?.aborted) {
        throw createAbortError();
      }
      resetTimeout();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      resetTimeout();
      await writeStreamChunk(writer, Buffer.from(value));
      receivedBytes += value.byteLength;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        emitHfDownloadProgress(options, task, {
          receivedBytes,
          totalBytes,
          knownAggregateBytes,
          aggregateCompletedBytes: progress.completedBytes || 0,
          startedAt,
        });
      }
    }
    await finishWriteStream(writer);
    return receivedBytes;
  } catch (error) {
    writer.destroy();
    if (timedOut) {
      throw createDetailedError(
        `${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`,
        {
          url: task.url,
          file: task.file,
          stallTimeoutMs,
        },
        error,
      );
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    linked.cleanup();
  }
}

/**
 * @param {DownloadOptions} options
 * @param {HfDownloadTask} task
 * @param {unknown} error
 * @param {number} nextAttempt
 * @param {number} maxAttempts
 * @param {string} [range]
 * @returns {void}
 */
function emitDownloadRetryProgress(
  options,
  task,
  error,
  nextAttempt,
  maxAttempts,
  range = "",
) {
  const suffix = range ? ` (${range})` : "";
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      progressMode: "log-only",
      installLogLine: `${task.label} 다운로드 재시도 ${nextAttempt}/${maxAttempts}${suffix}: ${error instanceof Error ? error.message : String(error)}`,
    },
  );
}

/**
 * @param {DownloadOptions} options
 * @param {HfDownloadTask} task
 * @param {unknown} error
 * @returns {void}
 */
function emitRangeFallbackProgress(options, task, error) {
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, false),
    `${task.label}: ${task.file}`,
    {
      progressMode: "log-only",
      installLogLine: `${task.label} 범위 다운로드 실패로 일반 다운로드로 전환합니다: ${error instanceof Error ? error.message : String(error)}`,
    },
  );
}

/**
 * @param {DownloadOptions} options
 * @param {HfDownloadTask} task
 * @param {HfDownloadProgressState} state
 * @returns {void}
 */
function emitHfDownloadProgress(options, task, state) {
  const knownAggregateBytes = state.knownAggregateBytes || 0;
  const aggregateBytes = knownAggregateBytes
    ? Math.min(
        knownAggregateBytes,
        (state.aggregateCompletedBytes || 0) + state.receivedBytes,
      )
    : undefined;
  const fileBytes = state.totalBytes
    ? Math.min(state.receivedBytes, state.totalBytes)
    : undefined;
  const progressPercent =
    knownAggregateBytes && aggregateBytes !== undefined
      ? aggregateBytes / knownAggregateBytes
      : state.totalBytes && fileBytes !== undefined
        ? fileBytes / state.totalBytes
        : undefined;
  const elapsedSeconds = Math.max(0.001, (Date.now() - state.startedAt) / 1000);
  const speed = Math.max(0, state.receivedBytes / elapsedSeconds);
  const fileProgress = state.totalBytes
    ? `${formatBytes(state.receivedBytes)} / ${formatBytes(state.totalBytes)}`
    : `${formatBytes(state.receivedBytes)} 받음`;
  emitRuntimeProgress(
    options,
    task.progressPhase || "model_downloading",
    resolveDownloadProgressTitle(task, Boolean(state.completed)),
    `${task.label}: ${task.file}`,
    {
      progressMode:
        knownAggregateBytes || state.totalBytes ? "determinate" : "log-only",
      progressPercent,
      progressBytes: aggregateBytes ?? fileBytes,
      progressTotalBytes: knownAggregateBytes || state.totalBytes || undefined,
      progressBytesPerSecond: speed,
      installLogLine: state.completed
        ? `${task.label} 다운로드 완료: ${task.file} (${fileProgress})`
        : `${task.label} 다운로드 중: ${task.file} (${fileProgress})`,
    },
  );
}

/**
 * @param {HfDownloadTask} task
 * @param {boolean} completed
 * @returns {string}
 */
function resolveDownloadProgressTitle(task, completed) {
  if (completed) {
    return task.completeTitle || `${task.label} 다운로드 완료`;
  }
  return task.progressTitle || `${task.label} 다운로드 중`;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function pathDirname(filePath) {
  return path.dirname(filePath);
}

module.exports = {
  buildHfResolveUrl,
  createLinkedAbortController,
  downloadHfFileWithProgress,
  finishWriteStream,
  getFileSize,
  isAbortError,
  isUsableFile,
  probeContentLength,
  readContentLength,
  resolveDownloadRetryCount,
  resolveDownloadStallTimeoutMs,
  writeStreamChunk,
};
