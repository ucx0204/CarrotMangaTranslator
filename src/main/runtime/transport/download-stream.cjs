// @ts-check
/** @typedef {{ url: string; file: string; destination: string; label: string; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ knownAggregateBytes?: number; totalBytes?: number; completedBytes?: number }} DownloadProgress */
const { createWriteStream } = require("node:fs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");
const {
  createAbortError,
  createLinkedAbortController,
  finishWriteStream,
  readContentLength,
  resolveDownloadStallTimeoutMs,
  writeStreamChunk,
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
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  const watchdog = createStallWatchdog(linked.controller, stallTimeoutMs);
  const writer = createWriteStream(partPath, { flags: "wx" });
  try {
    return await performStreamDownload(
      task,
      options,
      progress,
      writer,
      linked.controller.signal,
      watchdog,
      startedAt,
    );
  } catch (error) {
    await destroyWriteStream(writer);
    if (watchdog.didTimeOut())
      throw buildStallError(task, stallTimeoutMs, error);
    throw error;
  } finally {
    watchdog.clear();
    linked.cleanup();
  }
}

/** @param {import("node:fs").WriteStream} writer @returns {Promise<void>} */
function destroyWriteStream(writer) {
  if (writer.closed) return Promise.resolve();
  return new Promise((resolve) => {
    writer.once("close", resolve);
    writer.destroy();
  });
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {import("node:fs").WriteStream} writer @param {AbortSignal} signal @param {ReturnType<typeof createStallWatchdog>} watchdog @param {number} startedAt */
async function performStreamDownload(
  task,
  options,
  progress,
  writer,
  signal,
  watchdog,
  startedAt,
) {
  watchdog.reset();
  const response = await fetch(task.url, { signal });
  const body = requireDownloadBody(task, response);
  const totalBytes = progress.totalBytes || readContentLength(response);
  const receivedBytes = await copyResponseBody(
    task,
    options,
    progress,
    body,
    writer,
    watchdog,
    totalBytes,
    startedAt,
  );
  await finishWriteStream(writer);
  return receivedBytes;
}

/** @param {HfDownloadTask} task @param {Response} response @returns {ReadableStream<Uint8Array>} */
function requireDownloadBody(task, response) {
  if (response.ok && response.body) return response.body;
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

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {DownloadProgress} progress @param {ReadableStream<Uint8Array>} body @param {import("node:fs").WriteStream} writer @param {ReturnType<typeof createStallWatchdog>} watchdog @param {number} totalBytes @param {number} startedAt */
async function copyResponseBody(
  task,
  options,
  progress,
  body,
  writer,
  watchdog,
  totalBytes,
  startedAt,
) {
  const reader = body.getReader();
  let receivedBytes = 0;
  let lastEmitAt = 0;
  while (true) {
    if (options.abortSignal?.aborted) throw createAbortError();
    watchdog.reset();
    const { done, value } = await reader.read();
    if (done) return receivedBytes;
    watchdog.reset();
    await writeStreamChunk(writer, Buffer.from(value));
    receivedBytes += value.byteLength;
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
