// @ts-check
/**
 * @typedef {{
 *   imageHeight?: unknown;
 *   imageWidth?: unknown;
 *   maxTokens?: unknown;
 *   promptOverrideText?: string | null;
 *   temperature?: unknown;
 *   topK?: unknown;
 *   topP?: unknown;
 *   [key: string]: unknown;
 * }} RequestOptions
 * @typedef {{ dataUrl?: string; height?: unknown; originalHeight?: unknown; originalWidth?: unknown; role: string; width?: unknown }} ImageVariant
 * @typedef {Record<string, unknown>} JsonRecord
 * @typedef {(options: RequestOptions) => string} ResolveRequestModelName
 */
const { DEFAULT_API_KEY } = require("./simple-page-defaults.cjs");
const {
  buildSystemPrompt,
  getOverlayPrompt,
  readPositiveInteger,
} = require("./simple-page-prompts.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredApiCustomHeadersJson,
  resolveConfiguredApiExtraBodyJson,
  resolveConfiguredApiKey,
  resolveConfiguredApiReasoningEffort,
  resolveConfiguredApiTemperature,
  resolveConfiguredApiTopK,
  resolveConfiguredApiTopP,
  resolveConfiguredCodexReasoningEffort,
} = require("./simple-page-model-config.cjs");

const FORBIDDEN_CUSTOM_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "host",
  "content-length",
  "cookie",
  "set-cookie",
]);

/**
 * @param {RequestOptions} options
 * @param {ImageVariant[]} imageVariants
 */
function buildMessages(options, imageVariants) {
  const promptText =
    options.promptOverrideText || getOverlayPrompt(options, imageVariants);
  const imageParts = imageVariants.flatMap((variant, index) => [
    {
      type: "image_url",
      image_url: {
        url: variant.dataUrl,
      },
    },
    {
      type: "text",
      text: describeImageVariant(variant, index, options),
    },
  ]);

  return [
    {
      role: "system",
      content: [{ type: "text", text: buildSystemPrompt(options) }],
    },
    {
      role: "user",
      content: [...imageParts, { type: "text", text: promptText }],
    },
  ];
}

/**
 * @param {RequestOptions} options
 * @param {ImageVariant[]} imageVariants
 * @param {string} [promptText]
 */
function buildResponsesInput(
  options,
  imageVariants,
  promptText = options.promptOverrideText ||
    getOverlayPrompt(options, imageVariants),
) {
  const content = imageVariants.flatMap((variant, index) => [
    {
      type: "input_image",
      image_url: variant.dataUrl,
      detail: "original",
    },
    {
      type: "input_text",
      text: describeImageVariant(variant, index, options),
    },
  ]);

  return [
    {
      role: "user",
      content: [...content, { type: "input_text", text: promptText }],
    },
  ];
}

/**
 * @param {ImageVariant} variant
 * @param {number} index
 * @param {RequestOptions} [options]
 */
function describeImageVariant(variant, index, options = {}) {
  if (variant.role === "full-page-context") {
    return describeFullPageContextVariant(variant, index, options);
  }

  const originalWidth =
    readPositiveInteger(options.imageWidth) ||
    readPositiveInteger(variant.originalWidth);
  const originalHeight =
    readPositiveInteger(options.imageHeight) ||
    readPositiveInteger(variant.originalHeight);
  const width = readPositiveInteger(variant.width);
  const height = readPositiveInteger(variant.height);
  const sizeText = width && height ? ` It is ${width}x${height} px.` : "";
  const originalSizeText =
    originalWidth && originalHeight
      ? ` Original page size is ${originalWidth}x${originalHeight} px.`
      : "";

  if (options.regionCropMode && index === 0) {
    return `Image ${index + 1}: the selected manga crop. Use it as the geometry authority.${sizeText}${originalSizeText}`;
  }

  if (variant.role === "openai-vision") {
    return `Image ${index + 1}: the full manga page prepared for OpenAI detail: original vision. Use it as the geometry authority.${sizeText}${originalSizeText}`;
  }

  if (variant.role === "enhanced") {
    return `Image ${index + 1}: the same full manga page rendered as grayscale/high-contrast assist view. Use it only for OCR help, never as the coordinate authority.${sizeText}${originalSizeText}`;
  }

  return `Image ${index + 1}: the original full manga page. Use it as the geometry authority.${sizeText}${originalSizeText}`;
}

/**
 * @param {ImageVariant} variant
 * @param {number} index
 * @param {RequestOptions} [options]
 */
function describeFullPageContextVariant(variant, index, options = {}) {
  const width = readPositiveInteger(variant.width);
  const height = readPositiveInteger(variant.height);
  const crop = readRegionContextCropRect(options.regionContextCropRect);
  const sizeText = width && height ? ` It is ${width}x${height} px.` : "";
  const cropText = crop
    ? ` The selected Image 1 crop comes from this full page at x=${crop.x}, y=${crop.y}, w=${crop.w}, h=${crop.h} original-page pixels.`
    : "";
  return `Image ${index + 1}: the original full manga page for selected-region context only. Use it to understand speaker, surrounding scene, nearby dialogue flow, and whether Image 1 is part of a larger balloon. Do not use it as the coordinate authority, and do not output text visible only outside Image 1.${sizeText}${cropText}`;
}

/** @param {unknown} value */
function readRegionContextCropRect(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const x = readNonNegativeInteger(record.x);
  const y = readNonNegativeInteger(record.y);
  const w = readPositiveInteger(record.w);
  const h = readPositiveInteger(record.h);
  return x !== null && y !== null && w && h ? { x, y, w, h } : null;
}

/** @param {unknown} value */
function readNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

/**
 * @param {RequestOptions} [options]
 * @returns {Record<string, string>}
 */
function buildChatRequestHeaders(options = {}) {
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json",
  };
  if (isOpenAICodexProvider(options)) {
    return headers;
  }
  if (isOpenAIApiProvider(options)) {
    const apiKey = resolveConfiguredApiKey(options);
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return {
      ...headers,
      ...resolveConfiguredApiCustomHeaders(options),
    };
  }
  headers.Authorization = `Bearer ${DEFAULT_API_KEY}`;
  return headers;
}

/**
 * @param {RequestOptions} options
 * @param {unknown[]} messages
 * @param {unknown} maxTokens
 * @param {ResolveRequestModelName} resolveRequestModelName
 */
function buildChatRequestBodyWithModelResolver(
  options,
  messages,
  maxTokens = options.maxTokens,
  resolveRequestModelName,
) {
  if (isOpenAICodexProvider(options)) {
    return {
      model: resolveRequestModelName(options),
      max_tokens: maxTokens,
      reasoning_effort: resolveConfiguredCodexReasoningEffort(options),
      messages,
    };
  }

  if (isOpenAIApiProvider(options)) {
    const body = {
      model: resolveRequestModelName(options),
      max_tokens: maxTokens,
      messages,
    };
    addOptionalField(
      body,
      "temperature",
      resolveConfiguredApiTemperature(options),
    );
    addOptionalField(body, "top_p", resolveConfiguredApiTopP(options));
    addOptionalField(body, "top_k", resolveConfiguredApiTopK(options));
    addOptionalField(
      body,
      "reasoning_effort",
      resolveConfiguredApiReasoningEffort(options),
    );
    const merged = {
      ...body,
      ...resolveConfiguredApiExtraBody(options),
      model: body.model,
      messages: body.messages,
      max_tokens: body.max_tokens,
    };
    return merged;
  }

  return {
    model: resolveRequestModelName(options),
    temperature: options.temperature,
    top_p: options.topP,
    top_k: options.topK,
    presence_penalty: 0,
    frequency_penalty: 0,
    max_tokens: maxTokens,
    reasoning_budget: 0,
    enable_thinking: false,
    messages,
  };
}

/**
 * @param {RequestOptions} options
 * @param {ImageVariant[]} imageVariants
 * @param {string} promptText
 * @param {string} systemPrompt
 * @param {ResolveRequestModelName} resolveRequestModelName
 */
function buildResponsesRequestBodyWithModelResolver(
  options,
  imageVariants,
  promptText,
  systemPrompt,
  resolveRequestModelName,
) {
  return {
    model: resolveRequestModelName(options),
    instructions: systemPrompt || buildSystemPrompt(options),
    input: buildResponsesInput(options, imageVariants, promptText),
    max_output_tokens: options.maxTokens,
    reasoning: {
      effort: resolveConfiguredCodexReasoningEffort(options),
    },
    stream: true,
    store: false,
  };
}

/**
 * @param {JsonRecord} target
 * @param {string} key
 * @param {unknown} value
 */
function addOptionalField(target, key, value) {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

/** @param {RequestOptions} [options] */
function resolveConfiguredApiExtraBody(options = {}) {
  return parseJsonObjectString(
    resolveConfiguredApiExtraBodyJson(options),
    "API extra request body JSON",
  );
}

/** @param {RequestOptions} [options] */
function resolveConfiguredApiCustomHeaders(options = {}) {
  return sanitizeCustomHeaders(
    parseJsonObjectString(
      resolveConfiguredApiCustomHeadersJson(options),
      "API custom headers JSON",
    ),
  );
}

/**
 * @param {unknown} raw
 * @param {string} label
 * @returns {JsonRecord}
 */
function parseJsonObjectString(raw, label) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw createApiSettingsError(`${label}을 JSON 객체로 읽지 못했습니다.`, {
      label,
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw createApiSettingsError(`${label}은 JSON 객체여야 합니다.`, { label });
  }
  return /** @type {JsonRecord} */ (parsed);
}

/**
 * @param {JsonRecord} headers
 * @returns {Record<string, string>}
 */
function sanitizeCustomHeaders(headers) {
  /** @type {Record<string, string>} */
  const sanitized = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName).trim();
    const normalized = name.toLowerCase();
    if (!name) {
      continue;
    }
    if (FORBIDDEN_CUSTOM_HEADER_NAMES.has(normalized)) {
      throw createApiSettingsError(
        `API custom headers JSON에서 ${name} 헤더는 덮어쓸 수 없습니다.`,
        { headerName: name },
      );
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      throw createApiSettingsError(
        `API custom headers JSON의 ${name} 값은 문자열, 숫자, boolean만 허용됩니다.`,
        { headerName: name },
      );
    }
    sanitized[name] = String(rawValue);
  }
  return sanitized;
}

/**
 * @param {string} message
 * @param {JsonRecord} [detail]
 */
function createApiSettingsError(message, detail = {}) {
  const error = new Error(message);
  Object.assign(error, {
    ...detail,
    failureCategory: "model-request",
    nonRetriable: true,
  });
  return error;
}

module.exports = {
  buildChatRequestBodyWithModelResolver,
  buildChatRequestHeaders,
  buildMessages,
  buildResponsesInput,
  buildResponsesRequestBodyWithModelResolver,
  describeImageVariant,
  parseJsonObjectString,
  resolveConfiguredApiCustomHeaders,
  resolveConfiguredApiExtraBody,
  sanitizeCustomHeaders,
};
