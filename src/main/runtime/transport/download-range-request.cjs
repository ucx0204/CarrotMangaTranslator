// @ts-check
/** @typedef {{ url: string; file: string; destination: string; label: string; [key: string]: unknown }} HfDownloadTask */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { abortSignal?: AbortSignal | null; [key: string]: unknown }} DownloadOptions */
/** @typedef {{ header: "etag" | "last-modified"; value: string }} RangeValidator */

const {
  createLinkedAbortController,
  readRetryAfterMs,
  resolveDownloadStallTimeoutMs,
  withDownloadRequestSlot,
} = require("./download-primitives.cjs");

/** @param {string} message @param {Record<string, unknown>} [detail] @param {unknown} [cause] */
function createDetailedError(message, detail = {}, cause) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(message)
  );
  if (cause !== undefined) error.cause = cause;
  Object.assign(error, detail);
  return error;
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end @param {number} totalBytes @param {RangeValidator | null} validator */
async function fetchRangeBuffer(
  task,
  options,
  start,
  end,
  totalBytes,
  validator,
) {
  return await withDownloadRequestSlot(options.abortSignal, () =>
    performRangeRequest(task, options, start, end, totalBytes, validator),
  );
}

/** @param {HfDownloadTask} task @param {DownloadOptions} options @param {number} start @param {number} end @param {number} totalBytes @param {RangeValidator | null} validator */
async function performRangeRequest(
  task,
  options,
  start,
  end,
  totalBytes,
  validator,
) {
  const range = `bytes=${start}-${end}`;
  const stallTimeoutMs = resolveDownloadStallTimeoutMs();
  const linked = createLinkedAbortController(options.abortSignal);
  const timeoutState = { timedOut: false };
  const timeout = setTimeout(
    () => abortRangeFetch(linked.controller, timeoutState),
    stallTimeoutMs,
  );
  try {
    const headers = {
      "Accept-Encoding": "identity",
      Range: range,
      "User-Agent": "carrot-manga-translator",
      ...(validator ? { "If-Range": validator.value } : {}),
    };
    const response = await fetch(task.url, {
      headers,
      signal: linked.controller.signal,
    });
    await assertRangeResponse(
      task,
      response,
      start,
      end,
      totalBytes,
      validator,
    );
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      validator: validator || readRangeValidator(response),
    };
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

/** @param {HfDownloadTask} task @param {Response} response @param {number} start @param {number} end @param {number} totalBytes @param {RangeValidator | null} validator */
async function assertRangeResponse(
  task,
  response,
  start,
  end,
  totalBytes,
  validator,
) {
  if (response.status === 200) {
    await cancelResponseBody(response);
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
  if (response.status === 206 && response.ok) {
    try {
      assertContentRange(task, response, start, end, totalBytes);
      assertRangeValidator(task, response, validator);
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    return;
  }
  await cancelResponseBody(response);
  const range = `bytes=${start}-${end}`;
  throw createDetailedError(
    `${task.label} 다운로드 조각에 실패했습니다 (${response.status}).`,
    {
      status: response.status,
      statusText: response.statusText,
      retryAfterMs: readRetryAfterMs(response),
      url: task.url,
      file: task.file,
      range,
    },
  );
}

/** @param {Response} response */
async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch (_error) {
    // error-policy-allow: the request controller still handles transports that reject cancellation.
  }
}

/** @param {HfDownloadTask} task @param {Response} response @param {number} start @param {number} end @param {number} totalBytes */
function assertContentRange(task, response, start, end, totalBytes) {
  const value = response.headers.get("content-range") || "";
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim());
  if (
    match &&
    Number(match[1]) === start &&
    Number(match[2]) === end &&
    Number(match[3]) === totalBytes
  )
    return;
  throw createDetailedError(
    `${task.label} 서버가 잘못된 다운로드 범위를 반환했습니다.`,
    {
      rangeInvalid: true,
      status: response.status,
      url: task.url,
      file: task.file,
      requestedRange: `bytes=${start}-${end}`,
      contentRange: value,
      expectedTotalBytes: totalBytes,
    },
  );
}

/** @param {HfDownloadTask} task @param {Response} response @param {RangeValidator | null} expected */
function assertRangeValidator(task, response, expected) {
  if (!expected) return;
  const received = response.headers.get(expected.header)?.trim() || "";
  if (!received || received === expected.value) return;
  throw createDetailedError(
    `${task.label} 다운로드 중 원격 파일이 변경되었습니다.`,
    {
      rangeInvalid: true,
      status: response.status,
      url: task.url,
      file: task.file,
      validatorHeader: expected.header,
      expectedValidator: expected.value,
      receivedValidator: received,
    },
  );
}

/** @param {Response} response @returns {RangeValidator | null} */
function readRangeValidator(response) {
  const etag = response.headers.get("etag")?.trim() || "";
  if (etag && !/^W\//i.test(etag)) return { header: "etag", value: etag };
  const lastModified = response.headers.get("last-modified")?.trim() || "";
  return lastModified ? { header: "last-modified", value: lastModified } : null;
}

/** @param {HfDownloadTask} task @param {string} range @param {number} stallTimeoutMs @param {unknown} cause */
function buildRangeStallError(task, range, stallTimeoutMs, cause) {
  return createDetailedError(
    `${task.label} 다운로드가 ${Math.round(stallTimeoutMs / 1000)}초 동안 응답하지 않았습니다.`,
    { url: task.url, file: task.file, range, stallTimeoutMs },
    cause,
  );
}

module.exports = { fetchRangeBuffer };
