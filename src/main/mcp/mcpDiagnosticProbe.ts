import { createLinkedDeadlineController } from "../httpResponseBudget";

/** One deadline covers fetch, byte inspection and response cancellation. */
export async function runMcpDiagnosticProbe(
  url: string,
  init: RequestInit,
  inspect: (response: Response, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const deadline = createLinkedDeadlineController(
    undefined,
    8000,
    "MCP 연결 진단",
  );
  try {
    await settleBeforeDeadline(
      inspectResponse(url, init, inspect, deadline.signal),
      deadline.signal,
    );
  } finally {
    deadline.cleanup();
  }
}

async function inspectResponse(
  url: string,
  init: RequestInit,
  inspect: (response: Response, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let response: Response | undefined;
  let failure: { error: unknown } | undefined;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal,
    });
    signal.throwIfAborted();
    await inspect(response, signal);
  } catch (error) {
    failure = { error };
  }
  try {
    if (response && !response.bodyUsed) await response.body?.cancel();
  } catch (error) {
    throw failure
      ? new AggregateError([failure.error, error], "MCP 진단 응답 정리 실패")
      : error;
  }
  if (failure) throw failure.error;
}

async function settleBeforeDeadline(
  pending: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    // Both promises keep rejection handlers even if defective transport cleanup
    // settles later. The signal already requests cancellation of the real fetch.
    await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
