// @ts-check
/** @typedef {{ url: string; file: string; destination: string; label: string; maximumBytes: number; expectedTotalBytes?: number; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number }} DownloadProgress */
const { open: fsOpen } = require("node:fs/promises");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");
const {
  assertDownloadSizeWithinBudget,
  createAbortError,
  createDownloadBudgetError,
  createLinkedAbortController,
  readContentLength,
  readRetryAfterMs,
  resolveDownloadStallTimeoutMs,
  withDownloadRequestSlot,
} = require("./download-primitives.cjs");
const { emitHfDownloadProgress } = require("./download-progress.cjs");

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {string} partPath @param {number} startedAt */
async function downloadHfFileByStream(
  task,
  options,
  progress,
  partPath,
  startedAt,
) {
  return await withDownloadRequestSlot(options.abortSignal, () =>
    downloadStreamInRequestSlot(task, options, progress, partPath, startedAt),
  );
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {string} partPath @param {number} startedAt */
async function downloadStreamInRequestSlot(
  task,
  options,
  progress,
  partPath,
  startedAt,
) {
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const file = await fsOpen(partPath, "wx");
  const linked = createLinkedAbortController(options.abortSignal);
  const watchdog = createStallWatchdog(linked.controller, stallTimeoutMs);
  let fileClosed = false;
  try {
    const receivedBytes = await performStreamDownload(
      task,
      options,
      progress,
      file,
      linked.controller.signal,
      watchdog,
      startedAt,
    );
    await file.close();
    fileClosed = true;
    return receivedBytes;
  } catch (error) {
    linked.controller.abort();
    if (!fileClosed) await closeFileAfterFailure(file);
    if (watchdog.didTimeOut())
      throw buildStallError(task, stallTimeoutMs, error);
    throw error;
  } finally {
    watchdog.clear();
    linked.cleanup();
  }
}

/** @param {import("node:fs/promises").FileHandle | null} file */
async function closeFileAfterFailure(file) {
  if (!file) return;
  try {
    await file.close();
  } catch (_error) {
    // error-policy-allow: preserve the original download or disk error.
  }
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {import("node:fs/promises").FileHandle} file @param {AbortSignal} signal @param {ReturnType<typeof createStallWatchdog>} watchdog @param {number} startedAt */
async function performStreamDownload(
  task,
  options,
  progress,
  file,
  signal,
  watchdog,
  startedAt,
) {
  watchdog.reset();
  const response = await fetch(task.url, {
    headers: {
      "Accept-Encoding": "identity",
      "User-Agent": "carrot-manga-translator",
    },
    signal,
  });
  const body = await requireDownloadBody(task, response);
  const responseLength = readContentLength(response);
  if (responseLength > 0) {
    await assertResponseLengthWithinBudget(task, response, responseLength);
  }
  // Keep the earlier HEAD or exact task size authoritative when available. This
  // prevents a proxy from replacing a large asset with a short HTTP 200 error document.
  const totalBytes =
    progress.totalBytes || task.expectedTotalBytes || responseLength;
  if (totalBytes > 0) {
    assertDownloadSizeWithinBudget(task, totalBytes);
  }
  const receivedBytes = await copyResponseBody(
    task,
    options,
    progress,
    body,
    file,
    signal,
    watchdog,
    totalBytes,
    startedAt,
  );
  assertCompleteStream(task, receivedBytes, totalBytes);
  return receivedBytes;
}

/** @param {HfDownloadTask} task @param {Response} response @param {number} responseLength */
async function assertResponseLengthWithinBudget(
  task,
  response,
  responseLength,
) {
  try {
    assertDownloadSizeWithinBudget(task, responseLength);
  } catch (error) {
    await cancelResponseBodySafely(response, error);
    throw error;
  }
}

/** @param {HfDownloadTask} task @param {number} receivedBytes @param {number} totalBytes */
function assertCompleteStream(task, receivedBytes, totalBytes) {
  if (!totalBytes || receivedBytes === totalBytes) return;
  throw createDetailedError(
    `${task.label} 다운로드 크기가 올바르지 않습니다.`,
    {
      url: task.url,
      file: task.file,
      expectedLength: totalBytes,
      receivedLength: receivedBytes,
    },
  );
}

/** @param {HfDownloadTask} task @param {Response} response @returns {Promise<ReadableStream<Uint8Array>>} */
async function requireDownloadBody(task, response) {
  if (response.ok && response.body) return response.body;
  try {
    await response.body?.cancel();
  } catch (_error) {
    // error-policy-allow: the linked request controller is aborted by the caller.
  }
  throw createDetailedError(
    `${task.label} 다운로드에 실패했습니다 (${response.status}).`,
    {
      status: response.status,
      statusText: response.statusText,
      retryAfterMs: readRetryAfterMs(response),
      url: task.url,
      file: task.file,
    },
  );
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {ReadableStream<Uint8Array>} body @param {import("node:fs/promises").FileHandle} file @param {AbortSignal} signal @param {ReturnType<typeof createStallWatchdog>} watchdog @param {number} totalBytes @param {number} startedAt */
async function copyResponseBody(
  task,
  options,
  progress,
  body,
  file,
  signal,
  watchdog,
  totalBytes,
  startedAt,
) {
  const reader = body.getReader();
  let receivedBytes = 0;
  let lastEmitAt = 0;
  /** @type {Promise<void> | null} */
  let abortCancel = null;
  const onAbort = () => {
    abortCancel = cancelReaderSafely(reader, signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfDownloadAborted(signal);
      watchdog.reset();
      const { done, value } = await reader.read();
      throwIfDownloadAborted(signal);
      if (done) return receivedBytes;
      watchdog.reset();
      const nextBytes = receivedBytes + value.byteLength;
      if (!Number.isSafeInteger(nextBytes) || nextBytes > task.maximumBytes) {
        const error = createDownloadBudgetError(
          task,
          task.maximumBytes,
          nextBytes,
        );
        await cancelReaderSafely(reader, error);
        throw error;
      }
      if (totalBytes > 0 && nextBytes > totalBytes) {
        const error = createDetailedError(
          `${task.label} 다운로드 본문이 예상 크기를 초과했습니다.`,
          {
            file: task.file,
            expectedLength: totalBytes,
            receivedLength: nextBytes,
            downloadBudgetExceeded: true,
            nonRetriable: true,
          },
        );
        await cancelReaderSafely(reader, error);
        throw error;
      }
      await writeFileChunk(task, file, Buffer.from(value));
      receivedBytes = nextBytes;
      const now = Date.now();
      if (now - lastEmitAt > 500) {
        lastEmitAt = now;
        emitChunkProgress(
          options,
          task,
          progress,
          receivedBytes,
          totalBytes,
          startedAt,
        );
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (abortCancel) await abortCancel;
    reader.releaseLock();
  }
}

/** @param {AbortSignal} signal */
function throwIfDownloadAborted(signal) {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : createAbortError();
}

/** @param {Response} response @param {unknown} reason */
async function cancelResponseBodySafely(response, reason) {
  try {
    await response.body?.cancel(reason);
  } catch (_error) {
    // error-policy-allow: response cancellation is cleanup and must preserve the primary download budget error.
  }
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {unknown} reason */
async function cancelReaderSafely(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch (_error) {
    // error-policy-allow: reader cancellation is cleanup and must preserve the primary abort/download error.
  }
}

/** @param {HfDownloadTask} task @param {import("node:fs/promises").FileHandle} file @param {Buffer} chunk */
async function writeFileChunk(task, file, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await file.write(chunk, offset, chunk.length - offset, null);
    if (result.bytesWritten <= 0) {
      throw createDetailedError(
        `${task.label} 다운로드 데이터를 파일에 쓰지 못했습니다.`,
        {
          fileWriteFailed: true,
          url: task.url,
          file: task.file,
          expectedLength: chunk.length,
          writtenLength: offset,
        },
      );
    }
    offset += result.bytesWritten;
  }
}

/** @param {DownloadOptions} options @param {HfDownloadTask} task @param {DownloadProgress} progress @param {number} receivedBytes @param {number} totalBytes @param {number} startedAt */
function emitChunkProgress(
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

/** @param {AbortController} controller @param {number} timeoutMs */
function createStallWatchdog(controller, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timeout = null;
  let timedOut = false;
  return {
    reset() {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    },
    clear() {
      if (timeout) clearTimeout(timeout);
    },
    didTimeOut() {
      return timedOut;
    },
  };
}

/** @param {HfDownloadTask} task @param {number} stallTimeoutMs @param {unknown} cause */
function buildStallError(task, stallTimeoutMs, cause) {
  return createDetailedError(
    `${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`,
    { url: task.url, file: task.file, stallTimeoutMs },
    cause,
  );
}

module.exports = { downloadHfFileByStream };
