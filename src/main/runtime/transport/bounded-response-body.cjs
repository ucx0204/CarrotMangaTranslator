// @ts-check

/** @typedef {{ label: string; maximumBytes: number; signal?: AbortSignal | null }} BoundedResponseOptions */

/** @param {string} label @param {number} maximumBytes @param {number} receivedBytes */
function createResponseTooLargeError(label, maximumBytes, receivedBytes) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(`${label} response exceeded ${maximumBytes} bytes.`)
  );
  error.name = "HttpResponseTooLargeError";
  error.code = "HTTP_RESPONSE_TOO_LARGE";
  error.nonRetriable = true;
  error.responseBudgetExceeded = true;
  error.failureCategory = "model-request";
  error.maximumBytes = maximumBytes;
  error.receivedBytes = receivedBytes;
  return error;
}

/** @param {Response} response @param {BoundedResponseOptions} options */
async function readBoundedResponseText(response, options) {
  assertPositiveSafeInteger(options.maximumBytes, "maximumBytes");
  throwIfAborted(options.signal);
  await rejectOversizedDeclaredBody(response, options);
  return response.body ? readBoundedBodyText(response.body, options) : "";
}

/** @param {Response} response @param {BoundedResponseOptions} options */
async function rejectOversizedDeclaredBody(response, options) {
  const declared = readIdentityContentLength(response);
  if (declared === null || declared <= options.maximumBytes) return;
  const error = createResponseTooLargeError(
    options.label,
    options.maximumBytes,
    declared,
  );
  await cancelResponseBody(response, error);
  throw error;
}

/** @param {ReadableStream<Uint8Array>} body @param {BoundedResponseOptions} options */
async function readBoundedBodyText(body, options) {
  const reader = body.getReader();
  const abortState = /** @type {{ cancel: Promise<void> | null }} */ ({
    cancel: null,
  });
  const onAbort = () => {
    abortState.cancel = cancelReaderSafely(
      reader,
      readAbortReason(options.signal),
    );
  };
  options.signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    return await decodeBoundedText(reader, options);
  } catch (error) {
    throw options.signal?.aborted ? readAbortReason(options.signal) : error;
  } finally {
    options.signal?.removeEventListener?.("abort", onAbort);
    await abortState.cancel;
    reader.releaseLock();
  }
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {BoundedResponseOptions} options */
async function decodeBoundedText(reader, options) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  /** @type {string[]} */
  const parts = [];
  let receivedBytes = 0;
  while (true) {
    throwIfAborted(options.signal);
    const chunk = await reader.read();
    throwIfAborted(options.signal);
    if (chunk.done) break;
    receivedBytes = await appendBoundedTextChunk(
      reader,
      decoder,
      parts,
      chunk.value,
      receivedBytes,
      options,
    );
  }
  parts.push(decoder.decode());
  return parts.join("");
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {TextDecoder} decoder @param {string[]} parts @param {Uint8Array} value @param {number} receivedBytes @param {BoundedResponseOptions} options */
async function appendBoundedTextChunk(
  reader,
  decoder,
  parts,
  value,
  receivedBytes,
  options,
) {
  const next = receivedBytes + value.byteLength;
  if (Number.isSafeInteger(next) && next <= options.maximumBytes) {
    parts.push(decoder.decode(value, { stream: true }));
    return next;
  }
  const error = createResponseTooLargeError(
    options.label,
    options.maximumBytes,
    next,
  );
  await cancelReaderSafely(reader, error);
  throw error;
}

/** @param {Response} response @param {unknown} [reason] */
async function cancelResponseBody(response, reason) {
  try {
    await response.body?.cancel(reason);
  } catch (_error) {
    // error-policy-allow: cancellation is best effort and must not replace the budget error.
  }
}

/** @param {ReadableStreamDefaultReader<Uint8Array>} reader @param {unknown} reason */
async function cancelReaderSafely(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch (_error) {
    // error-policy-allow: reader cancellation is cleanup and must preserve the primary abort/budget error.
  }
}

/** @param {Response} response */
function readIdentityContentLength(response) {
  const encoding = String(response.headers?.get?.("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") return null;
  const raw = response.headers?.get?.("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** @param {number} value @param {string} name */
function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

/** @param {AbortSignal | null | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) throw readAbortReason(signal);
}

/** @param {AbortSignal | null | undefined} signal */
function readAbortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

module.exports = {
  createResponseTooLargeError,
  readBoundedResponseText,
};
