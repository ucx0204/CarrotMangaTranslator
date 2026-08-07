// @ts-check
const { setTimeout: delay } = require("node:timers/promises");
const { createAbortError } = require("../simple-page-shell-utils.cjs");

/** @param {string} baseUrl */
async function isReachable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(2500),
    });
    const reachable = response.ok;
    try {
      await response.body?.cancel();
    } catch (_error) {
      // error-policy-allow: readiness only needs the status; unused body cancellation is best effort.
    }
    return reachable;
  } catch (_error) {
    return false;
  }
}

/** @param {string} baseUrl @param {import("node:child_process").ChildProcess} child @param {number} [timeoutMs] @param {AbortSignal | null} [signal] */
async function waitForReadyOrExit(
  baseUrl,
  child,
  timeoutMs = 1800000,
  signal = null,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertServerStillStarting(child, signal);
    if (await isReachable(baseUrl)) return;
    await delay(1500);
  }
  throw new Error(`Timed out while waiting for llama-server at ${baseUrl}`);
}

/** @param {import("node:child_process").ChildProcess} child @param {AbortSignal | null} signal */
function assertServerStillStarting(child, signal) {
  if (signal?.aborted) throw createAbortError();
  if (child.exitCode === null && child.signalCode === null) return;
  throw new Error(
    `llama-server exited before becoming ready (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`,
  );
}

module.exports = { isReachable, waitForReadyOrExit };
