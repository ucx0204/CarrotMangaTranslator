// @ts-check
/**
 * @typedef {{
 *   apiKey?: unknown;
 *   apiKeyMaxAttempts?: unknown;
 *   apiRetryDelaySeconds?: unknown;
 * }} ApiKeyOptions
 */

const DEFAULT_API_KEY_MAX_ATTEMPTS = 5;
const DEFAULT_API_RETRY_DELAY_SECONDS = 1;
const MAX_API_KEY_MAX_ATTEMPTS = 20;
const MAX_API_RETRY_DELAY_SECONDS = 300;
const MAX_CONFIGURED_API_KEYS = 100;

/**
 * @param {ApiKeyOptions} options
 * @param {boolean} allowOpenAiEnvironmentFallback
 */
function resolveApiKeys(options, allowOpenAiEnvironmentFallback) {
  const explicitApiKeys = parseApiKeyLines(
    process.env.MANGA_TRANSLATOR_API_KEY,
  );
  if (explicitApiKeys.length > 0) {
    return explicitApiKeys;
  }
  const configuredApiKeys = parseApiKeyLines(options.apiKey);
  if (configuredApiKeys.length > 0) {
    return configuredApiKeys;
  }
  return allowOpenAiEnvironmentFallback
    ? parseApiKeyLines(process.env.OPENAI_API_KEY)
    : [];
}

/** @param {unknown} value */
function parseApiKeyLines(value) {
  const keys = String(value ?? "")
    .split(/\r?\n/g)
    .map((key) => key.trim())
    .filter(Boolean);
  return [...new Set(keys)].slice(0, MAX_CONFIGURED_API_KEYS);
}

/** @param {ApiKeyOptions} options */
function resolveApiKeyMaxAttempts(options) {
  return resolveRange(
    process.env.MANGA_TRANSLATOR_API_KEY_MAX_ATTEMPTS,
    options.apiKeyMaxAttempts,
    DEFAULT_API_KEY_MAX_ATTEMPTS,
    1,
    MAX_API_KEY_MAX_ATTEMPTS,
    true,
  );
}

/** @param {ApiKeyOptions} options */
function resolveApiRetryDelaySeconds(options) {
  return resolveRange(
    process.env.MANGA_TRANSLATOR_API_RETRY_DELAY_SECONDS,
    options.apiRetryDelaySeconds,
    DEFAULT_API_RETRY_DELAY_SECONDS,
    0,
    MAX_API_RETRY_DELAY_SECONDS,
    false,
  );
}

/**
 * @param {unknown} envValue
 * @param {unknown} optionValue
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {boolean} round
 */
function resolveRange(envValue, optionValue, fallback, min, max, round) {
  const value = envValue !== undefined ? envValue : optionValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = round ? Math.round(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

module.exports = {
  parseApiKeyLines,
  resolveApiKeyMaxAttempts,
  resolveApiKeys,
  resolveApiRetryDelaySeconds,
};
