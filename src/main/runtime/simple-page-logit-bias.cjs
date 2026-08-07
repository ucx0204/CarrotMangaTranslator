// @ts-check
const { DEFAULT_API_KEY } = require("./simple-page-defaults.cjs");
const { truncateText } = require("./simple-page-runtime-common.cjs");
const {
  readBoundedResponseText,
} = require("./transport/bounded-response-body.cjs");
const {
  MAX_TOKENIZE_RESPONSE_BYTES,
} = require("./transport/network-budgets.cjs");

const DEFAULT_FORBIDDEN_TOKEN_TEXTS = ["<unused49>", "unused49"];
const DEFAULT_FORBIDDEN_TOKEN_BIAS = -100;
const DEFAULT_TOKENIZE_TIMEOUT_MS = 5000;
const MIN_TOKENIZE_TIMEOUT_MS = 1000;
const MAX_TOKENIZE_TIMEOUT_MS = 60000;

/**
 * @typedef {object} ForbiddenTokenBiasResolution
 * @property {number[]} tokenIds
 * @property {string[]} tokenTexts
 * @property {string} source
 * @property {string | null | undefined} [skippedReason]
 * @property {Array<Record<string, unknown>> | undefined} [diagnostics]
 */
/**
 * @typedef {{ baseUrl?: string | null }} LlamaServerRef
 * @typedef {{ abortSignal?: AbortSignal | null; disableUnused49LogitBias?: unknown; forbiddenTokenBias?: unknown; forbiddenTokenIds?: unknown; forbiddenTokenTexts?: unknown; tokenizeTimeoutMs?: unknown; [key: string]: unknown }} LogitBiasOptions
 * @typedef {Record<string, unknown> & { logit_bias?: unknown }} RequestBody
 * @typedef {{ tokenIds: number[]; endpoint: string | null; error: string | null }} TokenizeResult
 * @typedef {"disableUnused49LogitBias" | "forbiddenTokenBias" | "forbiddenTokenIds" | "forbiddenTokenTexts" | "tokenizeTimeoutMs"} LogitBiasOptionName
 */

/** @type {Map<string, ForbiddenTokenBiasResolution>} */
const forbiddenTokenBiasCache = new Map();

/**
 * @param {LlamaServerRef | null | undefined} server
 * @param {LogitBiasOptions} options
 * @param {RequestBody | null | undefined} requestBody
 */
async function applyLocalForbiddenTokenBias(server, options = {}, requestBody) {
  if (
    !requestBody ||
    typeof requestBody !== "object" ||
    Array.isArray(requestBody)
  ) {
    return {
      applied: false,
      skippedReason: "invalid-request-body",
      tokenIds: [],
      tokenTexts: [],
      source: "none",
    };
  }
  if (isTruthy(readOptionOrEnv(options, "disableUnused49LogitBias"))) {
    return {
      applied: false,
      skippedReason: "disabled",
      tokenIds: [],
      tokenTexts: [],
      source: "none",
    };
  }

  const resolved = await resolveLocalForbiddenTokenBias(server, options);
  if (resolved.tokenIds.length === 0) {
    return { ...resolved, applied: false };
  }

  const biasValue = resolveForbiddenTokenBias(options);
  requestBody.logit_bias = mergeLogitBias(
    requestBody.logit_bias,
    resolved.tokenIds,
    biasValue,
  );
  return {
    ...resolved,
    applied: true,
    bias: biasValue,
  };
}

/**
 * @param {LlamaServerRef | null | undefined} server
 * @param {LogitBiasOptions} [options]
 * @returns {Promise<ForbiddenTokenBiasResolution>}
 */
async function resolveLocalForbiddenTokenBias(server, options = {}) {
  const explicitIds = resolveConfiguredForbiddenTokenIds(options);
  if (explicitIds.length > 0) {
    return {
      tokenIds: explicitIds,
      tokenTexts: [],
      source: "configured-token-ids",
      skippedReason: null,
    };
  }

  const tokenTexts = resolveConfiguredForbiddenTokenTexts(options);
  const baseUrl = normalizeBaseUrl(server?.baseUrl);
  if (!baseUrl || tokenTexts.length === 0) {
    return {
      tokenIds: [],
      tokenTexts,
      source: "tokenize",
      skippedReason: baseUrl ? "no-token-texts" : "missing-base-url",
    };
  }

  const cacheKey = `${baseUrl}\u0000${tokenTexts.join("\u0000")}`;
  const cached = forbiddenTokenBiasCache.get(cacheKey);
  if (cached) {
    return cloneBiasResolution(cached);
  }

  const resolved = await resolveForbiddenTokenIdsFromTokenize(
    baseUrl,
    tokenTexts,
    options,
  );
  forbiddenTokenBiasCache.set(cacheKey, cloneBiasResolution(resolved));
  return resolved;
}

async function resolveForbiddenTokenIdsFromTokenize(
  /** @type {string} */
  baseUrl,
  /** @type {string[]} */
  tokenTexts,
  /** @type {LogitBiasOptions} */
  options = {},
) {
  /** @type {Set<number>} */
  const tokenIds = new Set();
  /** @type {Array<Record<string, unknown>>} */
  const diagnostics = [];
  for (const tokenText of tokenTexts) {
    const result = await tokenizeText(baseUrl, tokenText, options);
    const singleToken =
      result.tokenIds.length === 1 ? result.tokenIds[0] : null;
    if (singleToken !== null && Number.isInteger(singleToken)) {
      tokenIds.add(singleToken);
    }
    diagnostics.push({
      tokenText,
      tokenIds: result.tokenIds,
      accepted: Number.isInteger(singleToken),
      endpoint: result.endpoint,
      error: result.error,
    });
  }

  return {
    tokenIds: [...tokenIds],
    tokenTexts,
    source: "tokenize",
    skippedReason: tokenIds.size > 0 ? null : "tokenize-no-single-token",
    diagnostics,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} tokenText
 * @param {LogitBiasOptions} [options]
 * @returns {Promise<TokenizeResult>}
 */
async function tokenizeText(baseUrl, tokenText, options = {}) {
  const endpoints = buildTokenizeEndpoints(baseUrl);
  const bodies = [
    { content: tokenText, add_special: false, with_pieces: false },
    { text: tokenText, add_special: false, with_pieces: false },
  ];
  let lastError = "";

  for (const endpoint of endpoints) {
    for (const body of bodies) {
      const attempt = await requestTokenization(endpoint, body, options);
      if (attempt.tokenIds.length > 0) {
        return attempt;
      }
      lastError = attempt.error ?? "";
    }
  }

  return {
    tokenIds: [],
    endpoint: null,
    error: truncateText(lastError, 500),
  };
}

/**
 * @param {string} endpoint
 * @param {Record<string, unknown>} body
 * @param {LogitBiasOptions} options
 * @returns {Promise<TokenizeResult>}
 */
async function requestTokenization(endpoint, body, options) {
  const requestSignal = createTokenizeSignal(options);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEFAULT_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const rawText = await readBoundedResponseText(response, {
      label: "Local tokenize response",
      maximumBytes: MAX_TOKENIZE_RESPONSE_BYTES,
      signal: requestSignal,
    });
    return response.ok
      ? tokenizationFromSuccess(endpoint, rawText)
      : tokenizationFailure(
          `${endpoint} ${response.status} ${truncateText(rawText, 240)}`,
        );
  } catch (error) {
    if (isUserAbortError(error, options)) {
      throw error;
    }
    return tokenizationFailure(formatTokenizeError(endpoint, error));
  }
}

/** @param {string} endpoint @param {string} rawText @returns {TokenizeResult} */
function tokenizationFromSuccess(endpoint, rawText) {
  const tokenIds = extractTokenIds(JSON.parse(rawText));
  return tokenIds.length > 0
    ? { tokenIds, endpoint, error: null }
    : tokenizationFailure(`${endpoint} returned no token ids`);
}

/** @param {string} error @returns {TokenizeResult} */
function tokenizationFailure(error) {
  return { tokenIds: [], endpoint: null, error };
}

/**
 * @param {unknown} existing
 * @param {number[]} tokenIds
 * @param {number} biasValue
 */
function mergeLogitBias(existing, tokenIds, biasValue) {
  /** @type {Record<string, unknown>} */
  const merged =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
  for (const tokenId of tokenIds) {
    merged[String(tokenId)] = biasValue;
  }
  return merged;
}

/** @param {string} baseUrl */
function buildTokenizeEndpoints(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return [];
  }
  const rootUrl = normalized.replace(/\/v1$/i, "");
  return [...new Set([`${rootUrl}/tokenize`, `${normalized}/tokenize`])];
}

/**
 * @param {unknown} payload
 * @returns {number[]}
 */
function extractTokenIds(payload) {
  const record =
    payload && typeof payload === "object"
      ? /** @type {{ tokens?: unknown; token_ids?: unknown }} */ (payload)
      : {};
  const rawTokens = Array.isArray(payload)
    ? payload
    : Array.isArray(record.tokens)
      ? record.tokens
      : Array.isArray(record.token_ids)
        ? record.token_ids
        : [];
  return rawTokens
    .map(readTokenId)
    .filter((tokenId) => Number.isInteger(tokenId));
}

/** @param {unknown} token */
function readTokenId(token) {
  if (Number.isInteger(token)) {
    return token;
  }
  if (Array.isArray(token) && Number.isInteger(token[0])) {
    return token[0];
  }
  if (!token || typeof token !== "object") {
    return null;
  }
  for (const key of ["id", "token", "token_id"]) {
    const value = /** @type {Record<string, unknown>} */ (token)[key];
    if (Number.isInteger(value)) {
      return value;
    }
  }
  return null;
}

/** @param {LogitBiasOptions} [options] */
function resolveConfiguredForbiddenTokenTexts(options = {}) {
  const raw = readOptionOrEnv(options, "forbiddenTokenTexts");
  const parsed = parseDelimitedTextList(raw);
  return parsed.length > 0 ? parsed : DEFAULT_FORBIDDEN_TOKEN_TEXTS;
}

/** @param {LogitBiasOptions} [options] */
function resolveConfiguredForbiddenTokenIds(options = {}) {
  return parseTokenIdList(readOptionOrEnv(options, "forbiddenTokenIds"));
}

/**
 * @param {LogitBiasOptions} options
 * @param {LogitBiasOptionName} optionName
 */
function readOptionOrEnv(options, optionName) {
  const envName = {
    disableUnused49LogitBias: "MANGA_TRANSLATOR_DISABLE_UNUSED49_LOGIT_BIAS",
    forbiddenTokenBias: "MANGA_TRANSLATOR_FORBIDDEN_TOKEN_BIAS",
    forbiddenTokenIds: "MANGA_TRANSLATOR_FORBIDDEN_TOKEN_IDS",
    forbiddenTokenTexts: "MANGA_TRANSLATOR_FORBIDDEN_TOKEN_TEXTS",
    tokenizeTimeoutMs: "MANGA_TRANSLATOR_TOKENIZE_TIMEOUT_MS",
  }[optionName];
  if (envName && process.env[envName] !== undefined) {
    return process.env[envName];
  }
  return options[optionName];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseDelimitedTextList(value) {
  if (Array.isArray(value)) {
    return uniqueTexts(value);
  }
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return uniqueTexts(parsed);
      }
    } catch (_error) {
      // error-policy-allow: invalid JSON input falls through to delimiter parsing.
    }
  }
  return uniqueTexts(text.split(/[\r\n,]+/g));
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueTexts(values) {
  return [
    ...new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

/**
 * @param {unknown} value
 * @returns {number[]}
 */
function parseTokenIdList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/[\s,;]+/g)
        .filter(Boolean);
  /** @type {number[]} */
  const tokenIds = [];
  for (const item of values) {
    const tokenId =
      typeof item === "number" ? item : Number(String(item).trim());
    if (Number.isInteger(tokenId) && tokenId >= 0) {
      tokenIds.push(tokenId);
    }
  }
  return [...new Set(tokenIds)];
}

/** @param {LogitBiasOptions} [options] */
function resolveForbiddenTokenBias(options = {}) {
  const value = Number(readOptionOrEnv(options, "forbiddenTokenBias"));
  if (!Number.isFinite(value)) {
    return DEFAULT_FORBIDDEN_TOKEN_BIAS;
  }
  return Math.max(-100, Math.min(0, value));
}

/** @param {LogitBiasOptions} [options] */
function createTokenizeSignal(options = {}) {
  /** @type {AbortSignal[]} */
  const signals = [];
  if (options.abortSignal) {
    signals.push(options.abortSignal);
  }
  if (typeof AbortSignal.timeout === "function") {
    signals.push(AbortSignal.timeout(resolveTokenizeTimeoutMs(options)));
  }
  if (signals.length === 0) {
    return undefined;
  }
  if (signals.length === 1 || typeof AbortSignal.any !== "function") {
    return signals[0];
  }
  return AbortSignal.any(signals);
}

/** @param {LogitBiasOptions} [options] */
function resolveTokenizeTimeoutMs(options = {}) {
  const value = Number(readOptionOrEnv(options, "tokenizeTimeoutMs"));
  if (!Number.isFinite(value)) {
    return DEFAULT_TOKENIZE_TIMEOUT_MS;
  }
  return Math.max(
    MIN_TOKENIZE_TIMEOUT_MS,
    Math.min(MAX_TOKENIZE_TIMEOUT_MS, Math.round(value)),
  );
}

/** @param {unknown} value */
function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/g, "");
}

/** @param {unknown} value */
function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

/**
 * @param {unknown} error
 * @param {LogitBiasOptions} [options]
 */
function isUserAbortError(error, options = {}) {
  const errorRecord =
    error && typeof error === "object"
      ? /** @type {{ name?: unknown }} */ (error)
      : {};
  return Boolean(
    options.abortSignal?.aborted &&
    (errorRecord.name === "AbortError" || errorRecord.name === "TimeoutError"),
  );
}

/**
 * @param {string} endpoint
 * @param {unknown} error
 */
function formatTokenizeError(endpoint, error) {
  if (error instanceof Error) {
    return `${endpoint} ${error.name}: ${truncateText(error.message, 240)}`;
  }
  return `${endpoint} ${truncateText(String(error), 240)}`;
}

/** @param {ForbiddenTokenBiasResolution} value */
function cloneBiasResolution(value) {
  return {
    ...value,
    tokenIds: [...(value.tokenIds || [])],
    tokenTexts: [...(value.tokenTexts || [])],
    diagnostics: value.diagnostics
      ? value.diagnostics.map((item) => ({ ...item }))
      : undefined,
  };
}

function clearLocalForbiddenTokenBiasCache() {
  forbiddenTokenBiasCache.clear();
}

module.exports = {
  applyLocalForbiddenTokenBias,
  buildTokenizeEndpoints,
  clearLocalForbiddenTokenBiasCache,
  extractTokenIds,
  resolveLocalForbiddenTokenBias,
};
