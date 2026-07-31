// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { apiKey?: unknown; [key: string]: unknown }} TranslationRequestOptions
 * @typedef {Record<string, unknown>} RequestSummary
 * @typedef {{ resetAt?: number; resetInSeconds?: number }} UsageLimitFailure
 */

const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveProviderDisplayName,
} = require("../simple-page-model-config.cjs");
const { parseApiKeyLines } = require("../simple-page-api-key-config.cjs");
const {
  extractModelOutputFailure,
} = require("../simple-page-response-text.cjs");
const {
  resolveConfiguredApiCustomHeaders,
  resolveConfiguredApiExtraBody,
} = require("../simple-page-request-builders.cjs");
const {
  createDetailedError,
  truncateText,
} = require("./model-runtime-services.cjs");

/**
 * @param {TranslationRequestOptions} options
 * @param {RequestSummary} requestSummary
 * @param {Response} response
 * @param {string} rawText
 * @returns {Error}
 */
function createHttpFailureError(options, requestSummary, response, rawText) {
  const retryableCredentialFailure = isApiKeyCredentialFailure(
    response.status,
    rawText,
  );
  const usageLimitFailure = isOpenAICodexProvider(options)
    ? readUsageLimitFailure(response.status, rawText)
    : null;
  const nonRetriable =
    (isNonRetriableHttpStatus(response.status) || usageLimitFailure !== null) &&
    !retryableCredentialFailure;
  const message = usageLimitFailure
    ? buildUsageLimitFailureMessage(options, usageLimitFailure)
    : buildHttpFailureMessage(options, response.status, response.statusText);
  return createDetailedError(message, {
    requestSummary,
    status: response.status,
    statusText: response.statusText,
    rawTextPreview: truncateSensitiveText(rawText, options, 4000),
    ...(usageLimitFailure
      ? {
          usageLimitReached: true,
          ...(usageLimitFailure.resetAt !== undefined
            ? { usageLimitResetAt: usageLimitFailure.resetAt }
            : {}),
          ...(usageLimitFailure.resetInSeconds !== undefined
            ? {
                usageLimitResetInSeconds: usageLimitFailure.resetInSeconds,
              }
            : {}),
        }
      : {}),
    ...(retryableCredentialFailure ? { apiKeyRetryable: true } : {}),
    ...(nonRetriable
      ? { nonRetriable: true, failureCategory: "model-request" }
      : {}),
  });
}

/**
 * A Codex account usage limit is different from a transient 429. Retrying page
 * after page cannot succeed until the service-provided reset window has passed.
 *
 * @param {number} status
 * @param {unknown} rawText
 * @returns {UsageLimitFailure | null}
 */
function readUsageLimitFailure(status, rawText) {
  if (status !== 429) {
    return null;
  }
  try {
    const parsed = asRecord(JSON.parse(String(rawText ?? "")));
    const detail = asRecord(parsed?.error);
    const type = String(detail?.type ?? "")
      .trim()
      .toLowerCase();
    if (type !== "usage_limit_reached") {
      return null;
    }
    return {
      resetAt: readNonNegativeInteger(detail?.resets_at),
      resetInSeconds: readNonNegativeInteger(detail?.resets_in_seconds),
    };
  } catch (_error) {
    return null;
  }
}

/**
 * @param {TranslationRequestOptions} options
 * @param {UsageLimitFailure} failure
 */
function buildUsageLimitFailureMessage(options, failure) {
  const providerName = resolveProviderDisplayName(options);
  const resetHint = buildUsageLimitResetHint(failure);
  return `${providerName} 요청 실패: 사용 한도에 도달했습니다.${resetHint} 한도가 초기화된 후 다시 시도하거나 설정에서 다른 모델 제공자를 선택하세요.`;
}

/** @param {UsageLimitFailure} failure */
function buildUsageLimitResetHint(failure) {
  const resetInSeconds =
    failure.resetInSeconds ??
    (failure.resetAt === undefined
      ? undefined
      : Math.max(0, Math.ceil(failure.resetAt - Date.now() / 1000)));
  if (resetInSeconds === undefined) {
    return "";
  }
  if (resetInSeconds <= 0) {
    return " 사용 한도가 곧 초기화될 예정입니다.";
  }
  return ` 사용 한도 초기화까지 약 ${formatRemainingDuration(resetInSeconds)} 남았습니다.`;
}

/** @param {number} totalSeconds */
function formatRemainingDuration(totalSeconds) {
  const totalMinutes = Math.max(1, Math.floor(totalSeconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  return `${totalMinutes}분`;
}

/** @param {unknown} value */
function readNonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {TranslationRequestOptions} options
 * @param {number} status
 * @param {string} statusText
 * @returns {string}
 */
function buildHttpFailureMessage(options, status, statusText) {
  const providerName = resolveProviderDisplayName(options);
  const statusLabel = formatHttpStatus(status, statusText);
  if (!isOpenAIApiProvider(options)) {
    return `${providerName} request failed (${status}).`;
  }
  if (status === 401 || status === 403) {
    return `API 오류 ${statusLabel}: 인증에 실패했습니다. API 키가 잘못됐거나 만료됐을 수 있습니다. 키가 맞다면 선택한 모델이 이미지 입력을 지원하는지 확인하세요. 자세한 내용은 로그를 확인하세요.`;
  }
  if (isNonRetriableHttpStatus(status)) {
    return `API 오류 ${statusLabel}: 요청이 거부되었습니다. API 키 또는 Base URL이 맞는지, 선택한 모델이 이미지 입력을 지원하는지 확인하세요. 자세한 내용은 로그를 확인하세요.`;
  }
  return `API 오류 ${statusLabel}: 요청이 실패했습니다. 잠시 후 다시 시도하거나 로그를 확인하세요.`;
}

/** @param {number} status @param {unknown} statusText */
function formatHttpStatus(status, statusText) {
  const suffix = String(statusText ?? "").trim();
  return suffix ? `${status} ${suffix}` : String(status);
}

/** @param {number} status */
function isNonRetriableHttpStatus(status) {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 402 &&
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  );
}

/** @param {number} status */
function isRetryableApiKeyHttpStatus(status) {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status < 600)
  );
}

/** @param {unknown} error */
function isRetryableApiKeyError(error) {
  if (!error || typeof error !== "object" || findAbortError(error)) {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (error);
  if (record.apiKeyRetryable === true) {
    return true;
  }
  if (record.modelTransportError === true) {
    return true;
  }
  if (typeof record.status === "number") {
    return isRetryableApiKeyHttpStatus(record.status);
  }
  return false;
}

/** @param {number} status @param {unknown} rawText */
function isApiKeyCredentialFailure(status, rawText) {
  return (
    status === 400 &&
    /API_KEY_INVALID|Please pass a valid API key|API key (?:is not valid|expired|has been reported as leaked)/i.test(
      String(rawText ?? ""),
    )
  );
}

/** @param {unknown} error */
function findAbortError(error) {
  let current = error;
  const visited = new Set();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = /** @type {Record<string, unknown>} */ (current);
    if (record.name === "AbortError") {
      return current;
    }
    current = record.cause;
  }
  return null;
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} detail
 * @param {unknown} cause
 */
function createModelTransportError(message, detail, cause) {
  const abortError = findAbortError(cause);
  if (abortError) {
    return abortError;
  }
  return createDetailedError(
    message,
    {
      ...detail,
      failureCategory: "model-request",
      modelTransportError: true,
    },
    cause,
  );
}

/**
 * @param {unknown} error
 * @param {number} attemptCount
 * @param {number} keyCount
 */
function markApiKeyRetriesExhausted(error, attemptCount, keyCount) {
  const target =
    error && typeof error === "object"
      ? /** @type {Error & Record<string, unknown>} */ (error)
      : createDetailedError(String(error ?? "API request failed."), {}, error);
  target.nonRetriable = true;
  target.failureCategory =
    typeof target.failureCategory === "string" && target.failureCategory
      ? target.failureCategory
      : "model-request";
  target.apiKeyRetriesExhausted = true;
  target.apiKeyAttemptCount = attemptCount;
  target.apiKeyCount = keyCount;
  return target;
}

/**
 * @param {unknown} value
 * @param {TranslationRequestOptions} options
 * @param {number} maxLength
 */
function truncateSensitiveText(value, options, maxLength) {
  return truncateText(redactConfiguredApiKeys(value, options), maxLength);
}

/**
 * @param {unknown} value
 * @param {TranslationRequestOptions} options
 */
function redactSensitivePayload(value, options) {
  try {
    const serialized = JSON.stringify(value, (_key, nestedValue) =>
      typeof nestedValue === "string"
        ? redactConfiguredApiKeys(nestedValue, options)
        : nestedValue,
    );
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch (_error) {
    return "[redacted-unserializable-response]";
  }
}

/**
 * @param {unknown} value
 * @param {TranslationRequestOptions} options
 */
function redactConfiguredApiKeys(value, options) {
  let text = String(value ?? "");
  const keys = collectSensitiveValues(options)
    .flatMap((key) => parseSensitiveValues(key))
    .filter(Boolean);
  for (const key of new Set(keys)) {
    text = text.split(key).join("[redacted-api-key]");
  }
  return text;
}

/** @param {unknown} value */
function parseSensitiveValues(value) {
  if (typeof value !== "string") {
    const text = String(value ?? "").trim();
    return text ? [text] : [];
  }
  return parseApiKeyLines(value);
}

/** @param {TranslationRequestOptions} options */
function collectSensitiveValues(options) {
  return [
    options.apiKey,
    process.env.MANGA_TRANSLATOR_API_KEY,
    process.env.OPENAI_API_KEY,
    ...collectSensitiveConfiguredValues(options),
  ];
}

/**
 * Settings parsing can fail before a request is sent. Redaction must not replace
 * that original validation error, so invalid optional settings contribute no
 * additional secrets here.
 * @param {TranslationRequestOptions} options
 * @returns {unknown[]}
 */
function collectSensitiveConfiguredValues(options) {
  /** @type {unknown[]} */
  const values = [];
  try {
    collectSensitiveHeaderValues(options, values);
  } catch (_error) {
    // error-policy-allow: the request path reports the original settings parse error.
  }
  try {
    collectSensitiveObjectValues(
      resolveConfiguredApiExtraBody(options),
      values,
    );
  } catch (_error) {
    // error-policy-allow: the request path reports the original settings parse error.
  }
  return values;
}

/** @param {TranslationRequestOptions} options @param {unknown[]} values */
function collectSensitiveHeaderValues(options, values) {
  for (const [key, value] of Object.entries(
    resolveConfiguredApiCustomHeaders(options),
  )) {
    if (isSensitiveConfigKey(key)) {
      values.push(value);
    }
  }
}

/**
 * @param {unknown} value
 * @param {unknown[]} values
 * @param {string} [keyName]
 */
function collectSensitiveObjectValues(value, values, keyName = "") {
  if (value === null || value === undefined) {
    return;
  }
  if (isSensitivePrimitive(value, keyName)) {
    values.push(value);
    return;
  }
  if (Array.isArray(value)) {
    collectSensitiveArrayValues(value, values, keyName);
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    collectSensitiveObjectValues(nestedValue, values, key);
  }
}

/** @param {unknown} value @param {string} keyName */
function isSensitivePrimitive(value, keyName) {
  if (!isSensitiveConfigKey(keyName)) {
    return false;
  }
  return ["string", "number", "boolean"].includes(typeof value);
}

/** @param {unknown[]} items @param {unknown[]} values @param {string} keyName */
function collectSensitiveArrayValues(items, values, keyName) {
  for (const item of items) {
    collectSensitiveObjectValues(item, values, keyName);
  }
}

/** @param {unknown} key */
function isSensitiveConfigKey(key) {
  return /api[-_ ]?key|token|secret|authorization|auth|password/i.test(
    String(key ?? ""),
  );
}

/**
 * @param {unknown} parsed
 * @param {string} rawText
 * @param {RequestSummary} requestSummary
 * @param {TranslationRequestOptions} options
 * @returns {Error}
 */
function createEmptyOutputError(parsed, rawText, requestSummary, options) {
  const parsedRecord =
    parsed && typeof parsed === "object"
      ? /** @type {Record<string, unknown>} */ (parsed)
      : {};
  const failure = extractModelOutputFailure(parsedRecord);
  if (!failure) {
    return createDetailedError("Model returned an empty response.", {
      requestSummary,
      rawTextPreview: truncateSensitiveText(rawText, options, 4000),
      rawResponse: redactSensitivePayload(parsed, options),
      failureCategory: "empty-model-response",
    });
  }
  return createDetailedError(failure.message, {
    requestSummary,
    rawTextPreview: truncateSensitiveText(rawText, options, 4000),
    rawResponse: redactSensitivePayload(parsed, options),
    failureCategory: failure.failureCategory,
    ...(failure.nonRetriable ? { nonRetriable: true } : {}),
    ...(failure.outputTruncated ? { outputTruncated: true } : {}),
  });
}

module.exports = {
  buildHttpFailureMessage,
  createEmptyOutputError,
  createHttpFailureError,
  createModelTransportError,
  findAbortError,
  isRetryableApiKeyError,
  isRetryableApiKeyHttpStatus,
  markApiKeyRetriesExhausted,
  truncateSensitiveText,
};
