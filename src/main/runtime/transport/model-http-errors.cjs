// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { apiKey?: unknown; [key: string]: unknown }} TranslationRequestOptions
 * @typedef {Record<string, unknown>} RequestSummary
 */

const {
  isOpenAIApiProvider,
  resolveProviderDisplayName,
} = require("../simple-page-model-config.cjs");
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
  const nonRetriable = isNonRetriableHttpStatus(response.status);
  const message = buildHttpFailureMessage(
    options,
    response.status,
    response.statusText,
  );
  return createDetailedError(message, {
    requestSummary,
    status: response.status,
    statusText: response.statusText,
    rawTextPreview: truncateSensitiveText(rawText, options, 4000),
    ...(nonRetriable
      ? { nonRetriable: true, failureCategory: "model-request" }
      : {}),
  });
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
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  );
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
function redactConfiguredApiKeys(value, options) {
  let text = String(value ?? "");
  const keys = collectSensitiveValues(options)
    .map((key) => String(key ?? "").trim())
    .filter((key) => key.length >= 6);
  for (const key of new Set(keys)) {
    text = text.split(key).join("[redacted-api-key]");
  }
  return text;
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
      rawResponse: parsed,
      failureCategory: "empty-model-response",
    });
  }
  return createDetailedError(failure.message, {
    requestSummary,
    rawTextPreview: truncateSensitiveText(rawText, options, 4000),
    rawResponse: parsed,
    failureCategory: failure.failureCategory,
    ...(failure.nonRetriable ? { nonRetriable: true } : {}),
  });
}

module.exports = {
  buildHttpFailureMessage,
  createEmptyOutputError,
  createHttpFailureError,
  truncateSensitiveText,
};
