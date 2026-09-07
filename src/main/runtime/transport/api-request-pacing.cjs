// @ts-check
const { setTimeout: delay } = require("node:timers/promises");

const {
  resolveApiRequestIntervalSeconds,
} = require("../simple-page-api-key-config.cjs");

/** @type {Map<string, {lastStart: number, tail: Promise<void>}>} */
const schedules = new Map();

/**
 * Reserve actual request starts, including retries, across concurrent API jobs.
 * The tail releases at dispatch, so request duration already counts toward the gap.
 * @param {import("../runtime-jsdoc-types").RuntimeOptions} options
 */
async function waitForApiRequestStart(options) {
  const interval = resolveApiRequestIntervalSeconds(options) * 1000;
  if (!interval) return;
  const signal = options.abortSignal ?? undefined;
  signal?.throwIfAborted();
  const key = String(
    process.env.MANGA_TRANSLATOR_API_BASE_URL ?? options.apiBaseUrl ?? "",
  ).replace(/\/+$/, "");
  const schedule = schedules.get(key) ?? {
    lastStart: -Infinity,
    tail: Promise.resolve(),
  };
  schedules.set(key, schedule);
  const slot = schedule.tail.then(async () => {
    signal?.throwIfAborted();
    const remaining = interval - (performance.now() - schedule.lastStart);
    if (remaining > 0) await delay(remaining, undefined, { signal });
    signal?.throwIfAborted();
    schedule.lastStart = performance.now();
  });
  // A cancelled slot must not poison the next request's queue.
  schedule.tail = slot.then(
    () => undefined,
    () => undefined,
  );
  if (!signal) return slot;
  await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    slot
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

module.exports = { waitForApiRequestStart };
