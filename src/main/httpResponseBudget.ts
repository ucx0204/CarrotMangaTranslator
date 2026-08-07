export class HttpResponseTooLargeError extends Error {
  readonly code = "HTTP_RESPONSE_TOO_LARGE";
  readonly nonRetriable = true;
  readonly responseBudgetExceeded = true;

  constructor(
    readonly label: string,
    readonly maximumBytes: number,
    readonly receivedBytes: number,
  ) {
    super(`${label} 응답이 허용 크기 ${maximumBytes} bytes를 초과했습니다.`);
    this.name = "HttpResponseTooLargeError";
  }
}

export class HttpRequestDeadlineError extends Error {
  readonly code = "HTTP_REQUEST_DEADLINE_EXCEEDED";
  readonly nonRetriable = true;
  readonly requestDeadlineExceeded = true;

  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} 요청이 ${timeoutMs}ms 제한을 초과했습니다.`);
    this.name = "HttpRequestDeadlineError";
  }
}

export type BoundedResponseTextOptions = {
  label: string;
  maximumBytes: number;
  signal?: AbortSignal | null;
};

export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseTextOptions,
): Promise<string> {
  const { label, maximumBytes, signal } = options;
  assertPositiveSafeInteger(maximumBytes, "maximumBytes");
  throwIfAborted(signal);
  await rejectOversizedDeclaredBody(response, label, maximumBytes);
  return response.body ? readBoundedBodyText(response.body, options) : "";
}

async function rejectOversizedDeclaredBody(
  response: Response,
  label: string,
  maximumBytes: number,
): Promise<void> {
  const declared = readIdentityContentLength(response);
  if (declared === null || declared <= maximumBytes) return;
  const error = new HttpResponseTooLargeError(label, maximumBytes, declared);
  await cancelBodySafely(response, error);
  throw error;
}

async function readBoundedBodyText(
  body: ReadableStream<Uint8Array>,
  options: BoundedResponseTextOptions,
): Promise<string> {
  const reader = body.getReader();
  const abortState: { cancel: Promise<void> | null } = { cancel: null };
  const onAbort = () => {
    abortState.cancel = cancelReaderSafely(
      reader,
      readAbortReason(options.signal),
    );
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await decodeBoundedText(reader, options);
  } catch (error) {
    throw options.signal?.aborted ? readAbortReason(options.signal) : error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await abortState.cancel;
    reader.releaseLock();
  }
}

async function decodeBoundedText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: BoundedResponseTextOptions,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const parts: string[] = [];
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

async function appendBoundedTextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  parts: string[],
  value: Uint8Array,
  receivedBytes: number,
  options: BoundedResponseTextOptions,
): Promise<number> {
  const next = receivedBytes + value.byteLength;
  if (Number.isSafeInteger(next) && next <= options.maximumBytes) {
    parts.push(decoder.decode(value, { stream: true }));
    return next;
  }
  const error = new HttpResponseTooLargeError(
    options.label,
    options.maximumBytes,
    next,
  );
  await cancelReaderSafely(reader, error);
  throw error;
}

export function createLinkedDeadlineController(
  parentSignal: AbortSignal | null | undefined,
  timeoutMs: number,
  label: string,
): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeOut: () => boolean;
} {
  assertPositiveSafeInteger(timeoutMs, "timeoutMs");
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;

  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(readAbortReason(parentSignal));
    }
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    if (!controller.signal.aborted) {
      controller.abort(new HttpRequestDeadlineError(label, timeoutMs));
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
    didTimeOut: () => timedOut,
  };
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function readIdentityContentLength(response: Response): number | null {
  const encoding = (response.headers.get("content-encoding") ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") {
    return null;
  }
  const raw = response.headers.get("content-length");
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function cancelBodySafely(
  response: Response,
  reason?: unknown,
): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch (_error) {
    // error-policy-allow: cancellation is best effort and must not replace the response budget error.
  }
}

async function cancelReaderSafely(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch (_error) {
    // error-policy-allow: reader cancellation is cleanup and must preserve the primary abort/budget error.
  }
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw readAbortReason(signal);
  }
}

function readAbortReason(signal?: AbortSignal | null): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("Aborted", "AbortError");
}
