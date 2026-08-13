// @ts-check
const { setTimeout: delay } = require("node:timers/promises");

/** @typedef {(delayMs: number, signal?: AbortSignal | null) => Promise<void>} DownloadRetryWaitScheduler */

/** @type {DownloadRetryWaitScheduler} */
const productionScheduler = (delayMs, signal) =>
  delay(delayMs, undefined, { signal: signal ?? undefined });

/** @type {DownloadRetryWaitScheduler} */
let activeScheduler = productionScheduler;

/** @param {number} delayMs @param {AbortSignal | null | undefined} [signal] */
async function waitForDownloadRetry(delayMs, signal) {
  await activeScheduler(delayMs, signal);
}

/**
 * Internal deterministic test seam. Production callers always use the
 * abort-aware timers/promises scheduler above; tests may remove wall-clock
 * waiting without changing retry count, transfer, integrity, cleanup, or
 * commit behavior.
 *
 * @param {DownloadRetryWaitScheduler} scheduler
 * @returns {() => void}
 */
function setDownloadRetryWaitSchedulerForTests(scheduler) {
  if (typeof scheduler !== "function") {
    throw new TypeError("Download retry wait scheduler must be a function.");
  }
  const previous = activeScheduler;
  activeScheduler = scheduler;
  let restored = false;
  return () => {
    if (restored || activeScheduler !== scheduler) return;
    restored = true;
    activeScheduler = previous;
  };
}

module.exports = {
  setDownloadRetryWaitSchedulerForTests,
  waitForDownloadRetry,
};
