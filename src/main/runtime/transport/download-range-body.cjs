// @ts-check
const {
  assertDownloadSizeWithinBudget,
  createDownloadBudgetError,
} = require("./download-primitives.cjs");

/** @typedef {{ file: string; label: string; maximumBytes: number }} RangeTask */

/** @param {Response} response @param {number} expectedLength @param {AbortSignal} signal @param {RangeTask} task */
async function readExactRangeBuffer(response, expectedLength, signal, task) {
  assertExpectedRangeLength(task, expectedLength);
  await assertDeclaredRangeLength(response, task, expectedLength);
  const body = requireRangeBody(response, task, expectedLength);
  const chunks = await readRangeChunks(body, signal, task, expectedLength);
  if (chunks.received !== expectedLength) {
    throw createRangeLengthError(task, expectedLength, chunks.received);
  }
  return Buffer.concat(chunks.parts, chunks.received);
}

/** @param {RangeTask} task @param {number} expectedLength */
function assertExpectedRangeLength(task, expectedLength) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 1) {
    const error = createRangeLengthError(task, expectedLength, 0);
    error.downloadBudgetInvalid = true;
    error.nonRetriable = true;
    throw error;
  }
  assertDownloadSizeWithinBudget(task, expectedLength);
}

/** @param {Response} response @param {RangeTask} task @param {number} expectedLength */
async function assertDeclaredRangeLength(response, task, expectedLength) {
  const declared = readIdentityContentLength(response);
  if (declared === null || declared === expectedLength) return;
  const error =
    declared > expectedLength
      ? createDownloadBudgetError(task, expectedLength, declared)
      : createRangeLengthError(task, expectedLength, declared);
  await cancelResponseBody(response, error);
  throw error;
}

/** @param {Response} response @param {RangeTask} task @param {number} expectedLength */
function requireRangeBody(response, task, expectedLength) {
  if (response.body) return response.body;
  throw createRangeLengthError(task, expectedLength, 0);
}

/** @param {ReadableStream<Uint8Array>} body @param {AbortSignal} signal @param {RangeTask} task @param {number} expectedLength */
async function readRangeChunks(body, signal, task, expectedLength) {
  const reader = body.getReader();
  /** @type {Buffer[]} */
  const parts = [];
  let received = 0;
  /** @type {Promise<void> | null} */
  let abortCancel = null;
  const onAbort = () => {
    abortCancel = cancelReaderSafely(reader, readAbortReason(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      received = await appendRangeChunk(
        reader,
        parts,
        chunk.value,
        received,
        expectedLength,
        task,
      );
    }
    return { parts, received };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (abortCancel) await abortCancel;
    reader.releaseLock();
  }
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {Buffer[]} parts @param {Uint8Array} value @param {number} received @param {number} expectedLength @param {RangeTask} task */
async function appendRangeChunk(
  reader,
  parts,
  value,
  received,
  expectedLength,
  task,
) {
  const next = received + value.byteLength;
  if (Number.isSafeInteger(next) && next <= expectedLength) {
    parts.push(Buffer.from(value));
    return next;
  }
  const error = createDownloadBudgetError(task, expectedLength, next);
  await cancelReaderSafely(reader, error);
  throw error;
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {unknown} reason */
async function cancelReaderSafely(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch (_error) {
    // error-policy-allow: reader cancellation is cleanup and must preserve the primary range/budget error.
  }
}

/** @param {RangeTask} task @param {number} expectedLength @param {number} receivedLength */
function createRangeLengthError(task, expectedLength, receivedLength) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(`${task.label} 다운로드 조각 크기가 올바르지 않습니다.`)
  );
  error.file = task.file;
  error.expectedLength = expectedLength;
  error.receivedLength = receivedLength;
  return error;
}

/** @param {Response} response */
function readIdentityContentLength(response) {
  const encoding = String(response.headers.get("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") return null;
  const raw = response.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** @param {Response} response @param {unknown} reason */
async function cancelResponseBody(response, reason) {
  try {
    await response.body?.cancel(reason);
  } catch (_error) {
    // error-policy-allow: cancellation must not replace the protocol/budget error.
  }
}

/** @param {AbortSignal} signal */
function throwIfAborted(signal) {
  if (signal.aborted) throw readAbortReason(signal);
}

/** @param {AbortSignal} signal */
function readAbortReason(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

module.exports = { readExactRangeBuffer };
