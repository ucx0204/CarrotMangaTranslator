// @ts-check
/**
 * @typedef {{
 *   apiBaseUrl?: unknown;
 *   apiCustomHeadersJson?: unknown;
 *   apiExtraBodyJson?: unknown;
 *   apiKey?: unknown;
 *   apiKeyMaxAttempts?: unknown;
 *   apiModel?: unknown;
 *   apiReasoningEffort?: unknown;
 *   apiRetryDelaySeconds?: unknown;
 *   apiTemperature?: unknown;
 *   apiTopK?: unknown;
 *   apiTopP?: unknown;
 *   codexModel?: unknown;
 *   codexReasoningEffort?: unknown;
 *   draftModelFile?: unknown;
 *   draftModelRepo?: unknown;
 *   localMmprojPath?: unknown;
 *   localModelPath?: unknown;
 *   mmprojFile?: unknown;
 *   mmprojRepo?: unknown;
 *   modelFile?: unknown;
 *   modelProvider?: unknown;
 *   modelRepo?: unknown;
 *   modelSource?: unknown;
 *   [key: string]: unknown;
 * }} ModelConfigOptions
 */
const path = require("node:path");
const {
  resolveApiKeyMaxAttempts,
  resolveApiKeys,
  resolveApiRetryDelaySeconds,
} = require("./simple-page-api-key-config.cjs");

const {
  DEFAULT_API_BASE_URL,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_MODEL,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_HF_FILE,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_HF,
  DEFAULT_MODEL_HF,
} = require("./simple-page-defaults.cjs");

function resolveConfiguredModelSource(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return String(options.modelSource ?? "").trim() === "local"
    ? "local"
    : "huggingface";
}

function resolveModelProvider(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  const value = String(options.modelProvider ?? "").trim();
  if (value === "openai-codex" || value === "openai-api") {
    return value;
  }
  return "gemma";
}

function isOpenAICodexProvider(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveModelProvider(options) === "openai-codex";
}

function isOpenAIApiProvider(options = /** @type {ModelConfigOptions} */ ({})) {
  return resolveModelProvider(options) === "openai-api";
}

function isOllamaOpenAiCompatibleEndpoint(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  if (!isOpenAIApiProvider(options)) return false;
  try {
    // Ollama exposes both its native API and OpenAI-compatible `/v1` surface
    // through the same default port, including LAN-hosted daemons.
    return new URL(resolveConfiguredApiBaseUrl(options)).port === "11434";
  } catch (_error) {
    return false;
  }
}

function isOllamaCloudApiModel(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    isOllamaOpenAiCompatibleEndpoint(options) &&
    /(?:-cloud|:cloud)$/i.test(resolveConfiguredApiModel(options))
  );
}

function resolveProviderDisplayName(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  if (isOpenAICodexProvider(options)) {
    return "OpenAI Codex";
  }
  if (isOpenAIApiProvider(options)) {
    return "API";
  }
  return "Gemma";
}

function resolveConfiguredCodexModel(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    String(
      options.codexModel ?? process.env.MANGA_TRANSLATOR_CODEX_MODEL ?? "",
    ).trim() || DEFAULT_CODEX_MODEL
  );
}

function resolveConfiguredCodexReasoningEffort(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  const value = String(
    process.env.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT ??
      options.codexReasoningEffort ??
      "",
  ).trim();
  if (value === "minimal") {
    return "low";
  }
  return ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
    value,
  )
    ? value
    : DEFAULT_CODEX_REASONING_EFFORT;
}

/** @param {unknown} value */
function coerceOpenAiCompatibleBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  let url;
  try {
    url = new URL(text);
  } catch (_error) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/+$/g, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/g, "");
  return url.toString().replace(/\/$/g, "");
}

function resolveConfiguredApiBaseUrl(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    coerceOpenAiCompatibleBaseUrl(
      process.env.MANGA_TRANSLATOR_API_BASE_URL ?? options.apiBaseUrl,
    ) || DEFAULT_API_BASE_URL
  );
}

/** @param {unknown} value */
function isOfficialOpenAiApiBaseUrl(value) {
  const baseUrl = coerceOpenAiCompatibleBaseUrl(value);
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.openai.com";
  } catch (_error) {
    return false;
  }
}

function resolveConfiguredApiModel(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    String(
      process.env.MANGA_TRANSLATOR_API_MODEL ?? options.apiModel ?? "",
    ).trim() || DEFAULT_API_MODEL
  );
}

function resolveConfiguredApiKey(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveConfiguredApiKeys(options)[0] ?? "";
}

function resolveConfiguredApiKeys(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveApiKeys(
    options,
    isOfficialOpenAiApiBaseUrl(resolveConfiguredApiBaseUrl(options)),
  );
}

function resolveConfiguredApiKeyMaxAttempts(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveApiKeyMaxAttempts(options);
}

function resolveConfiguredApiRetryDelaySeconds(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveApiRetryDelaySeconds(options);
}

function resolveConfiguredApiTemperature(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveNullableNumber(
    process.env.MANGA_TRANSLATOR_API_TEMPERATURE,
    options.apiTemperature,
    DEFAULT_API_TEMPERATURE,
    0,
    2,
  );
}

function resolveConfiguredApiTopP(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveNullableNumber(
    process.env.MANGA_TRANSLATOR_API_TOP_P,
    options.apiTopP,
    DEFAULT_API_TOP_P,
    0,
    1,
  );
}

function resolveConfiguredApiTopK(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveNullableInteger(
    process.env.MANGA_TRANSLATOR_API_TOP_K,
    options.apiTopK,
    DEFAULT_API_TOP_K,
    1,
    1000,
  );
}

function resolveConfiguredApiReasoningEffort(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return resolveNullableReasoningEffort(
    process.env.MANGA_TRANSLATOR_API_REASONING_EFFORT,
    options.apiReasoningEffort,
    DEFAULT_API_REASONING_EFFORT,
  );
}

function resolveConfiguredApiExtraBodyJson(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return String(
    process.env.MANGA_TRANSLATOR_API_EXTRA_BODY ??
      options.apiExtraBodyJson ??
      DEFAULT_API_EXTRA_BODY_JSON,
  ).trim();
}

function resolveConfiguredApiCustomHeadersJson(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return String(
    process.env.MANGA_TRANSLATOR_API_HEADERS ??
      options.apiCustomHeadersJson ??
      DEFAULT_API_CUSTOM_HEADERS_JSON,
  ).trim();
}

/**
 * @param {unknown} envValue
 * @param {unknown} optionValue
 * @param {number | null} fallback
 * @param {number} min
 * @param {number} max
 */
function resolveNullableNumber(envValue, optionValue, fallback, min, max) {
  const value = envValue !== undefined ? envValue : optionValue;
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * @param {unknown} envValue
 * @param {unknown} optionValue
 * @param {number | null} fallback
 * @param {number} min
 * @param {number} max
 */
function resolveNullableInteger(envValue, optionValue, fallback, min, max) {
  const value = envValue !== undefined ? envValue : optionValue;
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/**
 * @param {unknown} envValue
 * @param {unknown} optionValue
 * @param {string | null} fallback
 */
function resolveNullableReasoningEffort(envValue, optionValue, fallback) {
  const value = envValue !== undefined ? envValue : optionValue;
  if (value === null || value === "") {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(
    normalized,
  )
    ? normalized
    : fallback;
}

function resolveConfiguredLocalModelPath(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  const value = String(options.localModelPath ?? "").trim();
  return value ? path.resolve(value) : null;
}

function resolveConfiguredLocalMmprojPath(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  const value = String(options.localMmprojPath ?? "").trim();
  return value ? path.resolve(value) : null;
}

function resolveConfiguredModelRepo(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    String(
      options.modelRepo ?? process.env.MANGA_TRANSLATOR_MODEL_HF ?? "",
    ).trim() || DEFAULT_MODEL_HF
  );
}

function resolveConfiguredModelFile(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    String(options.modelFile ?? process.env.LLAMA_ARG_HF_FILE ?? "").trim() ||
    DEFAULT_HF_FILE
  );
}

function resolveConfiguredMmprojRepo(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    String(
      options.mmprojRepo ?? process.env.MANGA_TRANSLATOR_MMPROJ_HF ?? "",
    ).trim() || DEFAULT_MMPROJ_HF
  );
}

function resolveConfiguredMmprojFile(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return (
    String(
      options.mmprojFile ?? process.env.LLAMA_ARG_MMPROJ_FILE ?? "",
    ).trim() || DEFAULT_MMPROJ_FILE
  );
}

function resolveConfiguredDraftModelRepo(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return String(
    options.draftModelRepo ?? process.env.MANGA_TRANSLATOR_DRAFT_MODEL_HF ?? "",
  ).trim();
}

function resolveConfiguredDraftModelFile(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  return String(
    options.draftModelFile ??
      process.env.MANGA_TRANSLATOR_DRAFT_MODEL_FILE ??
      "",
  ).trim();
}

function resolveConfiguredDraftModelUrl(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (!repo || !file) {
    return null;
  }
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

function shouldUseConfiguredMmproj(
  options = /** @type {ModelConfigOptions} */ ({}),
) {
  const explicitRepo = String(
    options.mmprojRepo ?? process.env.MANGA_TRANSLATOR_MMPROJ_HF ?? "",
  ).trim();
  const explicitFile = String(
    options.mmprojFile ?? process.env.LLAMA_ARG_MMPROJ_FILE ?? "",
  ).trim();
  if (explicitRepo || explicitFile) {
    return true;
  }
  return resolveConfiguredModelRepo(options) === DEFAULT_MODEL_HF;
}

module.exports = {
  isOfficialOpenAiApiBaseUrl,
  isOllamaCloudApiModel,
  isOllamaOpenAiCompatibleEndpoint,
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredApiBaseUrl,
  resolveConfiguredApiCustomHeadersJson,
  resolveConfiguredApiExtraBodyJson,
  resolveConfiguredApiKey,
  resolveConfiguredApiKeyMaxAttempts,
  resolveConfiguredApiKeys,
  resolveConfiguredApiModel,
  resolveConfiguredApiReasoningEffort,
  resolveConfiguredApiRetryDelaySeconds,
  resolveConfiguredApiTemperature,
  resolveConfiguredApiTopK,
  resolveConfiguredApiTopP,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredDraftModelUrl,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  resolveModelProvider,
  resolveProviderDisplayName,
  shouldUseConfiguredMmproj,
};
