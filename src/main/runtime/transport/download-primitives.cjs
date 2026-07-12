// @ts-check
const { statSync } = require("node:fs");
const {
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
} = require("../simple-page-defaults.cjs");

/** @param {unknown} value */
function readPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function createAbortError() {
  const error = new Error("작업이 취소되었습니다.");
  error.name = "AbortError";
  return error;
}

/** @param {unknown} endpoint @param {string} repo @param {unknown} file */
function buildHfResolveUrl(endpoint, repo, file) {
  const filePath = String(file ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const base = String(endpoint || "https://huggingface.co").replace(/\/+$/, "");
  return `${base}/${repo}/resolve/main/${filePath}`;
}

/** @param {string} filePath */
function getFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch (_error) {
    return 0;
  }
}

/** @param {string} filePath */
function isUsableFile(filePath) {
  try {
    const stats = statSync(filePath);
    return Boolean(filePath) && stats.isFile() && stats.size > 0;
  } catch (_error) {
    return false;
  }
}

/** @param {string} url @param {AbortSignal | null | undefined} signal */
async function probeContentLength(url, signal) {
  if (signal?.aborted) throw createAbortError();
  const timeoutMs =
    readPositiveInteger(
      process.env.MANGA_TRANSLATOR_DOWNLOAD_METADATA_TIMEOUT_MS,
    ) || DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS;
  const linked = createLinkedAbortController(signal);
  const timeoutState = { timedOut: false };
  const timeout = setTimeout(
    () => abortForTimeout(linked.controller, timeoutState),
    timeoutMs,
  );
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: linked.controller.signal,
    });
    return response.ok ? readContentLength(response) : 0;
  } catch (_error) {
    if (signal?.aborted) throw createAbortError();
    return 0;
  } finally {
    clearTimeout(timeout);
    linked.cleanup();
  }
}

/** @param {AbortController} controller @param {{ timedOut: boolean }} state */
function abortForTimeout(controller, state) {
  state.timedOut = true;
  controller.abort();
}

function resolveDownloadRetryCount() {
  return (
    readPositiveInteger(
      process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRY_COUNT ??
        process.env.MANGA_TRANSLATOR_DOWNLOAD_RETRIES,
    ) || DEFAULT_DOWNLOAD_RETRY_COUNT
  );
}

function resolveDownloadStallTimeoutMs() {
  return (
    readPositiveInteger(
      process.env.MANGA_TRANSLATOR_DOWNLOAD_STALL_TIMEOUT_MS,
    ) || DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS
  );
}

/** @param {AbortSignal | null | undefined} parentSignal */
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

/** @param {unknown} error */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {{ name?: unknown }} */ (error).name === "AbortError",
  );
}

/** @param {Response} response */
function readContentLength(response) {
  const value = Number(response.headers?.get?.("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** @param {import("node:fs").WriteStream} writer @param {Uint8Array | Buffer} chunk @returns {Promise<void>} */
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

/** @param {import("node:fs").WriteStream} writer @returns {Promise<void>} */
function finishWriteStream(writer) {
  return new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(resolve);
  });
}

module.exports = {
  buildHfResolveUrl,
  createAbortError,
  createLinkedAbortController,
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
