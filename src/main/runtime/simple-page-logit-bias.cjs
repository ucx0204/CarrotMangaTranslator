// @ts-check
const { DEFAULT_API_KEY } = require("./simple-page-defaults.cjs");
const { truncateText } = require("./simple-page-runtime-common.cjs");

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

/** @type {Map<string, ForbiddenTokenBiasResolution>} */
const forbiddenTokenBiasCache = new Map();

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
  baseUrl,
  tokenTexts,
  options = {},
) {
  const tokenIds = new Set();
  const diagnostics = [];
  for (const tokenText of tokenTexts) {
    const result = await tokenizeText(baseUrl, tokenText, options);
    const singleToken =
      result.tokenIds.length === 1 ? result.tokenIds[0] : null;
    if (Number.isInteger(singleToken)) {
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

async function tokenizeText(baseUrl, tokenText, options = {}) {
  const endpoints = buildTokenizeEndpoints(baseUrl);
  const bodies = [
    { content: tokenText, add_special: false, with_pieces: false },
    { text: tokenText, add_special: false, with_pieces: false },
  ];
  let lastError = "";

  for (const endpoint of endpoints) {
    for (const body of bodies) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${DEFAULT_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: createTokenizeSignal(options),
        });
        const rawText = await response.text();
        if (!response.ok) {
          lastError = `${endpoint} ${response.status} ${truncateText(rawText, 240)}`;
          continue;
        }
        const tokenIds = extractTokenIds(JSON.parse(rawText));
        if (tokenIds.length > 0) {
          return { tokenIds, endpoint, error: null };
        }
        lastError = `${endpoint} returned no token ids`;
      } catch (error) {
        if (isUserAbortError(error, options)) {
          throw error;
        }
        lastError = formatTokenizeError(endpoint, error);
      }
    }
  }

  return {
    tokenIds: [],
    endpoint: null,
    error: truncateText(lastError, 500),
  };
}

function mergeLogitBias(existing, tokenIds, biasValue) {
  const merged =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
  for (const tokenId of tokenIds) {
    merged[String(tokenId)] = biasValue;
  }
  return merged;
}

function buildTokenizeEndpoints(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return [];
  }
  const rootUrl = normalized.replace(/\/v1$/i, "");
  return [...new Set([`${rootUrl}/tokenize`, `${normalized}/tokenize`])];
}

function extractTokenIds(payload) {
  const rawTokens = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.tokens)
      ? payload.tokens
      : Array.isArray(payload?.token_ids)
        ? payload.token_ids
        : [];
  return rawTokens
    .map(readTokenId)
    .filter((tokenId) => Number.isInteger(tokenId));
}

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
    const value = token[key];
    if (Number.isInteger(value)) {
      return value;
    }
  }
  return null;
}

function resolveConfiguredForbiddenTokenTexts(options = {}) {
  const raw = readOptionOrEnv(options, "forbiddenTokenTexts");
  const parsed = parseDelimitedTextList(raw);
  return parsed.length > 0 ? parsed : DEFAULT_FORBIDDEN_TOKEN_TEXTS;
}

function resolveConfiguredForbiddenTokenIds(options = {}) {
  return parseTokenIdList(readOptionOrEnv(options, "forbiddenTokenIds"));
}

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
      // Fall back to delimiter parsing below.
    }
  }
  return uniqueTexts(text.split(/[\r\n,]+/g));
}

function uniqueTexts(values) {
  return [
    ...new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function parseTokenIdList(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(/[\s,;]+/g)
        .filter(Boolean);
  return [
    ...new Set(
      values
        .map((item) => {
          const tokenId =
            typeof item === "number" ? item : Number(String(item).trim());
          return Number.isInteger(tokenId) && tokenId >= 0 ? tokenId : null;
        })
        .filter((tokenId) => Number.isInteger(tokenId)),
    ),
  ];
}

function resolveForbiddenTokenBias(options = {}) {
  const value = Number(readOptionOrEnv(options, "forbiddenTokenBias"));
  if (!Number.isFinite(value)) {
    return DEFAULT_FORBIDDEN_TOKEN_BIAS;
  }
  return Math.max(-100, Math.min(0, value));
}

function createTokenizeSignal(options = {}) {
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

function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/g, "");
}

function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function isUserAbortError(error, options = {}) {
  return Boolean(
    options.abortSignal?.aborted &&
    error &&
    typeof error === "object" &&
    (error.name === "AbortError" || error.name === "TimeoutError"),
  );
}

function formatTokenizeError(endpoint, error) {
  if (error instanceof Error) {
    return `${endpoint} ${error.name}: ${truncateText(error.message, 240)}`;
  }
  return `${endpoint} ${truncateText(String(error), 240)}`;
}

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
