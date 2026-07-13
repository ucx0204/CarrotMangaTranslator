// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & {
 *   apiKey?: unknown;
 *   apiKeyMaxAttempts?: unknown;
 *   apiRetryDelaySeconds?: unknown;
 *   modelProvider?: unknown;
 *   [key: string]: unknown;
 * }} ApiKeyRetryOptions
 * @typedef {{ attemptIndex: number; attemptTotal: number; keyIndex: number; keyCount: number; round: number }} ApiKeyAttempt
 */

const {
  isOpenAIApiProvider,
  resolveConfiguredApiKeyMaxAttempts,
  resolveConfiguredApiKeys,
  resolveConfiguredApiRetryDelaySeconds,
} = require("../simple-page-model-config.cjs");
const {
  findAbortError,
  isRetryableApiKeyError,
  markApiKeyRetriesExhausted,
} = require("./model-http-errors.cjs");

/**
 * Run an OpenAI-compatible API request with one selected key per attempt.
 * Attempts are ordered by round: key 1, key 2, ... key N, then repeat.
 * Non-API providers retain their existing single-attempt behavior.
 *
 * @template TResult
 * @param {ApiKeyRetryOptions} options
 * @param {(apiKey: string | undefined, attempt: ApiKeyAttempt) => Promise<TResult>} requestAttempt
 * @returns {Promise<TResult>}
 */
async function runWithApiKeyRetry(options, requestAttempt) {
  const apiKeys = isOpenAIApiProvider(options)
    ? resolveConfiguredApiKeys(options)
    : [];
  if (apiKeys.length === 0) {
    throwIfSignalAborted(options.abortSignal);
    return requestAttempt(undefined, {
      attemptIndex: 1,
      attemptTotal: 1,
      keyIndex: 0,
      keyCount: 0,
      round: 1,
    });
  }

  const maxAttemptsPerKey = resolveConfiguredApiKeyMaxAttempts(options);
  const attemptTotal = apiKeys.length * maxAttemptsPerKey;
  const delayMs = resolveConfiguredApiRetryDelaySeconds(options) * 1000;

  for (let attemptIndex = 1; attemptIndex <= attemptTotal; attemptIndex += 1) {
    const keyIndex = (attemptIndex - 1) % apiKeys.length;
    const round = Math.floor((attemptIndex - 1) / apiKeys.length) + 1;
    throwIfSignalAborted(options.abortSignal);
    try {
      return await requestAttempt(apiKeys[keyIndex], {
        attemptIndex,
        attemptTotal,
        keyIndex,
        keyCount: apiKeys.length,
        round,
      });
    } catch (error) {
      const abortError =
        readSignalAbortReason(options.abortSignal) || findAbortError(error);
      if (abortError) {
        throw abortError;
      }
      if (!isRetryableApiKeyError(error)) {
        throw error;
      }
      if (attemptIndex >= attemptTotal) {
        throw markApiKeyRetriesExhausted(error, attemptIndex, apiKeys.length);
      }
      await waitForRetryDelay(delayMs, options.abortSignal);
    }
  }

  throw new Error("API key retry loop ended unexpectedly.");
}

/** @param {AbortSignal | null | undefined} signal */
function throwIfSignalAborted(signal) {
  const abortError = readSignalAbortReason(signal);
  if (abortError) {
    throw abortError;
  }
}

/** @param {AbortSignal | null | undefined} signal */
function readSignalAbortReason(signal) {
  if (!signal?.aborted) {
    return null;
  }
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/**
 * @param {number} delayMs
 * @param {AbortSignal | null | undefined} signal
 */
function waitForRetryDelay(delayMs, signal) {
  throwIfSignalAborted(signal);
  if (!(delayMs > 0)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });

    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve(undefined);
    }

    function abort() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(
        readSignalAbortReason(signal) ||
          new DOMException("Aborted", "AbortError"),
      );
    }
  });
}

module.exports = {
  runWithApiKeyRetry,
};
