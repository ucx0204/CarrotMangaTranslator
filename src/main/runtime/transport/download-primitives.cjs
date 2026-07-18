// @ts-check
const { statSync } = require("node:fs");
const {
  DEFAULT_DOWNLOAD_METADATA_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_RANGE_CONCURRENCY,
  DEFAULT_DOWNLOAD_RETRY_COUNT,
  DEFAULT_DOWNLOAD_STALL_TIMEOUT_MS,
  HF_DOWNLOAD_CHUNK_SIZE,
} = require("../simple-page-defaults.cjs");

const MAX_DOWNLOAD_RANGE_CONCURRENCY = 8;
const MIN_DOWNLOAD_CHUNK_SIZE = 1024 * 1024;
const MAX_DOWNLOAD_CHUNK_SIZE = 32 * 1024 * 1024;
const NON_RETRYABLE_DOWNLOAD_FILE_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EDQUOT",
  "EFBIG",
  "EISDIR",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);
let activeDownloadRequests = 0;
/** @type {Array<{ cancelled: boolean; signal?: AbortSignal | null; onAbort: () => void; resolve: (release: () => void) => void; reject: (error: unknown) => void }>} */
const pendingDownloadRequests = [];

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

/** @param {unknown} endpoint @param {string} repo @param {unknown} file @param {unknown} [revision] */
function buildHfResolveUrl(endpoint, repo, file, revision = "main") {
  const filePath = String(file ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const base = String(endpoint || "https://huggingface.co").replace(/\/+$/, "");
  const safeRevision = encodeURIComponent(String(revision || "main"));
  return `${base}/${repo}/resolve/${safeRevision}/${filePath}`;
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
  return await withDownloadRequestSlot(signal, async () => {
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
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": "carrot-manga-translator",
        },
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
  });
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

/** @param {number} attempt @param {unknown} error */
function resolveDownloadRetryDelayMs(attempt, error) {
  const baseDelay = Math.min(30000, 1000 * 2 ** (attempt - 1));
  const detail =
    error && typeof error === "object"
      ? /** @type {{ retryAfterMs?: unknown; status?: unknown }} */ (error)
      : {};
  const retryAfterMs = Number(detail.retryAfterMs);
  const requestedDelay =
    Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : baseDelay;
  const jitter =
    Number(detail.status) === 429
      ? Math.floor(Math.random() * Math.min(1000, baseDelay / 2))
      : 0;
  return Math.min(60000, Math.max(baseDelay, requestedDelay) + jitter);
}

function resolveDownloadRangeConcurrency() {
  const requested = readPositiveInteger(
    process.env.MANGA_TRANSLATOR_DOWNLOAD_CONCURRENCY,
  );
  return Math.min(
    MAX_DOWNLOAD_RANGE_CONCURRENCY,
    requested || DEFAULT_DOWNLOAD_RANGE_CONCURRENCY,
  );
}

function resolveDownloadChunkSize() {
  const requestedMb = readPositiveInteger(
    process.env.MANGA_TRANSLATOR_DOWNLOAD_CHUNK_SIZE_MB,
  );
  if (!requestedMb) return HF_DOWNLOAD_CHUNK_SIZE;
  return Math.min(
    MAX_DOWNLOAD_CHUNK_SIZE,
    Math.max(MIN_DOWNLOAD_CHUNK_SIZE, requestedMb * 1024 * 1024),
  );
}

/** @template T @param {AbortSignal | null | undefined} signal @param {() => Promise<T>} operation @returns {Promise<T>} */
async function withDownloadRequestSlot(signal, operation) {
  const release = await acquireDownloadRequestSlot(signal);
  try {
    return await operation();
  } finally {
    release();
  }
}

/** @param {AbortSignal | null | undefined} signal @returns {Promise<() => void>} */
function acquireDownloadRequestSlot(signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  if (activeDownloadRequests < resolveDownloadRangeConcurrency()) {
    activeDownloadRequests += 1;
    return Promise.resolve(createDownloadRequestRelease());
  }
  return new Promise((resolve, reject) => {
    const entry = {
      cancelled: false,
      signal,
      onAbort: () => {
        entry.cancelled = true;
        reject(createAbortError());
      },
      resolve,
      reject,
    };
    signal?.addEventListener?.("abort", entry.onAbort, { once: true });
    pendingDownloadRequests.push(entry);
  });
}

function createDownloadRequestRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDownloadRequests = Math.max(0, activeDownloadRequests - 1);
    drainDownloadRequestQueue();
  };
}

function drainDownloadRequestQueue() {
  while (
    pendingDownloadRequests.length > 0 &&
    activeDownloadRequests < resolveDownloadRangeConcurrency()
  ) {
    const entry = pendingDownloadRequests.shift();
    if (!entry || entry.cancelled || entry.signal?.aborted) continue;
    entry.signal?.removeEventListener?.("abort", entry.onAbort);
    activeDownloadRequests += 1;
    entry.resolve(createDownloadRequestRelease());
  }
}

/** @template T, R @param {readonly T[]} items @param {number} concurrency @param {(item: T, index: number) => Promise<R>} mapper @returns {Promise<R[]>} */
async function mapWithConcurrency(items, concurrency, mapper) {
  if (items.length === 0) return [];
  const results = /** @type {R[]} */ (new Array(items.length));
  let nextIndex = 0;
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency) || 1),
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

/** @param {unknown} error */
function isNonRetryableDownloadHttpError(error) {
  if (!error || typeof error !== "object") return false;
  const status = Number(/** @type {{ status?: unknown }} */ (error).status);
  return [401, 403, 404, 407].includes(status);
}

/** @param {unknown} error */
function isNonRetryableDownloadFileError(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const detail =
      /** @type {{ code?: unknown; cause?: unknown; downloadCommitFailed?: unknown; fileWriteFailed?: unknown }} */ (
        current
      );
    if (
      detail.downloadCommitFailed === true ||
      detail.fileWriteFailed === true ||
      NON_RETRYABLE_DOWNLOAD_FILE_CODES.has(
        String(detail.code ?? "").toUpperCase(),
      )
    )
      return true;
    current = detail.cause;
  }
  return false;
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
  const contentEncoding = String(
    response.headers?.get?.("content-encoding") ?? "",
  )
    .trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") return 0;
  const value = Number(response.headers?.get?.("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** @param {Response} response */
function readRetryAfterMs(response) {
  const value = response.headers?.get?.("retry-after")?.trim() || "";
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

module.exports = {
  buildHfResolveUrl,
  createAbortError,
  createLinkedAbortController,
  getFileSize,
  isAbortError,
  isNonRetryableDownloadHttpError,
  isNonRetryableDownloadFileError,
  isUsableFile,
  mapWithConcurrency,
  probeContentLength,
  readContentLength,
  readRetryAfterMs,
  resolveDownloadRetryCount,
  resolveDownloadRetryDelayMs,
  resolveDownloadRangeConcurrency,
  resolveDownloadChunkSize,
  resolveDownloadStallTimeoutMs,
  withDownloadRequestSlot,
};
