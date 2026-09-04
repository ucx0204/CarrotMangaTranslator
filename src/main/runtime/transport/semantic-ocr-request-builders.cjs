// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & {
 *   maxTokens?:unknown;
 *   ctx?:unknown;
 *   temperature?:unknown;
 *   translationAttempt?:unknown;
 *   collectPageContext?:unknown;
 *   workContextBudget?:{
 *     effective?:{outputHeadroomTokens?:unknown};
 *   };
 *   [key:string]:unknown;
 * }} SemanticRequestOptions
 * @typedef {{role:string;dataUrl?:string;[key:string]:unknown}} ImageVariant
 * @typedef {Record<string, unknown>} RequestSummary
 */

const {
  describeImageVariant,
  isGoogleOpenAiCompatibleEndpoint,
} = require("../simple-page-request-builders.cjs");
const { buildChatRequestBody } = require("./request-bodies.cjs");
const {
  isOllamaCloudApiModel,
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
} = require("../simple-page-model-config.cjs");

const SEMANTIC_REPEAT_LAST_N = 256;
const SEMANTIC_REPEAT_PENALTY = 1.08;
const SEMANTIC_SEED = 424242;
const SEMANTIC_GROUPING_TOKENS_PER_UNIT = 64;
const SEMANTIC_TRANSLATION_BASE_TOKENS = 4096;
const SEMANTIC_TRANSLATION_TOKENS_PER_UNIT = 1024;
const SEMANTIC_PAGE_CONTEXT_TOKENS = 8192;
const SEMANTIC_TRANSLATION_MAX_RETRY_SCALE = 4;
const SEMANTIC_TRANSLATION_INPUT_RESERVE_TOKENS = 6400;
const WORK_CONTEXT_TRUNCATION_MESSAGE =
  "모델 응답이 작품 정보 예산 한도에서 잘렸습니다. 설정 > LLM > 작품 정보 예산을 늘려 주세요.";
const CONTEXT_LENGTH_TRUNCATION_MESSAGE =
  "모델 응답이 컨텍스트 길이 한도에서 잘렸습니다. 설정 > LLM > 컨텍스트 길이를 늘려 주세요. VRAM 사용량이 늘 수 있습니다.";
const STRUCTURED_BUDGET_TRUNCATION_MESSAGE =
  "모델 응답이 앱 내부 구조화 출력 한도에서 잘렸습니다. 사용자 설정 부족으로 단정할 수 없어 진단 가능한 일반 오류로 처리합니다.";
const MAX_OUTPUT_TRUNCATION_MESSAGE =
  "모델 응답이 최대 출력 토큰 한도에서 잘렸습니다. 설정 > LLM > 최대 출력 토큰을 늘려 주세요.";

/** @type {Record<string, [string, string?]>} */
const OUTPUT_TRUNCATION_DETAILS = {
  "work-context-budget": [
    WORK_CONTEXT_TRUNCATION_MESSAGE,
    "increase-work-context-budget",
  ],
  "context-length": [
    CONTEXT_LENGTH_TRUNCATION_MESSAGE,
    "increase-context-length",
  ],
  "structured-request-budget": [STRUCTURED_BUDGET_TRUNCATION_MESSAGE],
  default: [MAX_OUTPUT_TRUNCATION_MESSAGE, "increase-max-output-tokens"],
};

/** @param {RequestSummary} requestSummary */
function resolveOutputTruncationDetail(requestSummary) {
  const details =
    OUTPUT_TRUNCATION_DETAILS[
      String(requestSummary.responseTokenLimitSource)
    ] ?? OUTPUT_TRUNCATION_DETAILS.default;
  const [message, failureGuidance] = details;
  return failureGuidance ? { message, failureGuidance } : { message };
}

/**
 * @param {SemanticRequestOptions} options
 * @param {ImageVariant[]} variants
 * @param {string} promptText
 * @param {string} systemPrompt
 */
function buildSemanticImageMessages(
  options,
  variants,
  promptText,
  systemPrompt,
) {
  const imageParts = variants.flatMap((variant, index) => [
    { type: "image_url", image_url: { url: variant.dataUrl } },
    { type: "text", text: describeImageVariant(variant, index, options) },
  ]);
  return [
    { role: "system", content: [{ type: "text", text: systemPrompt }] },
    {
      role: "user",
      content: [...imageParts, { type: "text", text: promptText }],
    },
  ];
}

/**
 * @param {SemanticRequestOptions} options
 * @param {Array<Record<string,unknown>>} messages
 * @param {Record<string,unknown>} responseFormat
 * @param {"grouping"|"translation"} stage
 * @param {number} unitCount
 */
function buildSemanticStageRequestBody(
  options,
  messages,
  responseFormat,
  stage,
  unitCount,
) {
  const tokenBudget = resolveStructuredTokenBudget(options, stage, unitCount);
  if (isOpenAICodexProvider(options)) {
    return buildCodexSemanticRequestBody(
      options,
      messages,
      responseFormat,
      stage,
      tokenBudget.maxTokens,
    );
  }
  const body = buildChatRequestBody(options, messages, tokenBudget.maxTokens);
  if (isOpenAIApiProvider(options)) {
    return Object.assign(body, {
      response_format: buildOpenAiStructuredResponseFormat(
        options,
        responseFormat,
        stage,
      ),
    });
  }
  return Object.assign(body, {
    response_format: responseFormat,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_format: "none",
    reasoning_budget: 0,
    enable_thinking: false,
    temperature:
      stage === "grouping"
        ? 0
        : Math.max(0, Math.min(0.2, Number(options.temperature) || 0.2)),
    top_p: 0.95,
    top_k: 64,
    seed: SEMANTIC_SEED,
    cache_prompt: false,
    // Fixed sampling contract for stable small-model output.
    repeat_penalty: SEMANTIC_REPEAT_PENALTY,
    repeat_last_n: SEMANTIC_REPEAT_LAST_N,
  });
}

/**
 * OpenAI-compatible endpoints accept JSON Schema under `json_schema.schema`.
 * The local llama.cpp endpoint intentionally keeps its native
 * `{type:"json_object", schema}` contract in the branch above.
 *
 * @param {SemanticRequestOptions} options
 * @param {Record<string,unknown>} responseFormat
 * @param {"grouping"|"translation"} stage
 */
function buildOpenAiStructuredResponseFormat(options, responseFormat, stage) {
  const schema = readStructuredSchema(responseFormat);
  if (isOllamaCloudApiModel(options)) {
    // Ollama Cloud currently does not implement structured outputs. JSON mode
    // is its documented OpenAI-compatible contract; the prompt and strict
    // application parser still own the exact semantic response shape.
    return { type: "json_object" };
  }
  if (
    isGoogleOpenAiCompatibleEndpoint(options) &&
    stage === "translation" &&
    options.collectPageContext === true
  ) {
    // Gemini's OpenAI-compatible endpoint rejects the production page-context
    // schema once its nested candidate arrays are included, even though the
    // same model accepts the image request and the fixed-block schema. JSON
    // mode keeps the full prompt contract available while the runtime parser
    // remains the authority for validating and repairing every returned item.
    return { type: "json_object" };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: `manga_${stage}`,
      strict: true,
      schema: isGoogleOpenAiCompatibleEndpoint(options)
        ? toGoogleCompatibleJsonSchema(toOpenAiStrictJsonSchema(schema))
        : toOpenAiStrictJsonSchema(schema),
    },
  };
}

/**
 * OpenAI Structured Outputs requires every object property to appear in
 * `required`. Preserve the runtime contract of optional fields by making only
 * those originally omitted from `required` nullable before requiring them.
 * The local llama.cpp branch keeps its native optional-property schema.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function toOpenAiStrictJsonSchema(value) {
  if (Array.isArray(value)) {
    return value.map(toOpenAiStrictJsonSchema);
  }
  if (!value || typeof value !== "object") return value;

  const source = /** @type {Record<string,unknown>} */ (value);
  const properties = readSchemaProperties(source);
  const result = /** @type {Record<string,unknown>} */ ({});
  for (const [key, child] of Object.entries(source)) {
    if (key === "properties" && properties) continue;
    result[key] = toOpenAiStrictJsonSchema(child);
  }
  if (!properties) return result;

  const originallyRequired = new Set(
    Array.isArray(source.required)
      ? source.required.filter((key) => typeof key === "string")
      : [],
  );
  result.properties = Object.fromEntries(
    Object.entries(properties).map(([key, propertySchema]) => {
      const strictPropertySchema = toOpenAiStrictJsonSchema(propertySchema);
      return [
        key,
        originallyRequired.has(key)
          ? strictPropertySchema
          : makeJsonSchemaNullable(strictPropertySchema),
      ];
    }),
  );
  result.required = Object.keys(properties);
  return result;
}

/** @param {Record<string,unknown>} schema */
function readSchemaProperties(schema) {
  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    return null;
  }
  return /** @type {Record<string,unknown>} */ (schema.properties);
}

/** @param {unknown} schema */
function makeJsonSchemaNullable(schema) {
  if (jsonSchemaAcceptsNull(schema)) return schema;
  return { anyOf: [schema, { type: "null" }] };
}

/** @param {unknown} schema */
function jsonSchemaAcceptsNull(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const record = /** @type {Record<string,unknown>} */ (schema);
  if (record.type === "null") return true;
  if (Array.isArray(record.type) && record.type.includes("null")) return true;
  return [record.anyOf, record.oneOf].some(
    (variants) =>
      Array.isArray(variants) && variants.some(jsonSchemaAcceptsNull),
  );
}

const GOOGLE_JSON_SCHEMA_KEYS = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

/**
 * Gemini structured output accepts a documented JSON Schema subset. Keep
 * property names intact while recursively dropping unsupported schema
 * keywords such as `pattern` and `minLength` before they reach Google.
 *
 * @param {unknown} value
 * @param {string | null} [container]
 * @returns {unknown}
 */
function toGoogleCompatibleJsonSchema(value, container = null) {
  if (Array.isArray(value)) {
    return value.map((item) => toGoogleCompatibleJsonSchema(item));
  }
  if (!value || typeof value !== "object") return value;
  const source = /** @type {Record<string,unknown>} */ (value);
  const result = /** @type {Record<string,unknown>} */ ({});
  for (const [key, child] of Object.entries(source)) {
    if (
      container !== "properties" &&
      container !== "$defs" &&
      !GOOGLE_JSON_SCHEMA_KEYS.has(key)
    ) {
      continue;
    }
    result[key] = toGoogleCompatibleJsonSchema(
      child,
      key === "properties" || key === "$defs" ? key : null,
    );
  }
  return result;
}

/**
 * @param {SemanticRequestOptions} options
 * @param {Array<Record<string,unknown>>} messages
 * @param {Record<string,unknown>} responseFormat
 * @param {"grouping"|"translation"} stage
 * @param {number} maxTokens
 */
function buildCodexSemanticRequestBody(
  options,
  messages,
  responseFormat,
  stage,
  maxTokens,
) {
  const systemMessage = messages.find((message) => message.role === "system");
  const userMessages = messages.filter((message) => message.role !== "system");
  return {
    model: resolveConfiguredCodexModel(options),
    instructions: readMessageText(systemMessage),
    input: userMessages.map((message) => ({
      role: String(message.role ?? "user"),
      content: readMessageContent(message.content).map(toResponsesContentPart),
    })),
    max_output_tokens: maxTokens,
    reasoning: { effort: resolveConfiguredCodexReasoningEffort(options) },
    text: {
      format: {
        type: "json_schema",
        name: `manga_${stage}`,
        strict: true,
        schema: toOpenAiStrictJsonSchema(readStructuredSchema(responseFormat)),
      },
    },
    stream: true,
    store: false,
  };
}

/** @param {Record<string,unknown> | undefined} message */
function readMessageText(message) {
  return readMessageContent(message?.content)
    .filter((part) => part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
}

/** @param {unknown} value @returns {Array<Record<string,unknown>>} */
function readMessageContent(value) {
  return Array.isArray(value)
    ? value.filter(
        (part) => part && typeof part === "object" && !Array.isArray(part),
      )
    : [];
}

/** @param {Record<string,unknown>} part */
function toResponsesContentPart(part) {
  if (part.type === "image_url") {
    const imageUrl = /** @type {Record<string,unknown>} */ (
      part.image_url &&
      typeof part.image_url === "object" &&
      !Array.isArray(part.image_url)
        ? part.image_url
        : {}
    );
    return {
      type: "input_image",
      image_url: String(imageUrl.url ?? ""),
      detail: "original",
    };
  }
  return { type: "input_text", text: String(part.text ?? "") };
}

/** @param {Record<string,unknown>} responseFormat */
function readStructuredSchema(responseFormat) {
  const schema = responseFormat.schema;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema
    : responseFormat;
}

/**
 * @param {SemanticRequestOptions} options
 * @param {"grouping"|"translation"} stage
 * @param {number} unitCount
 */
function resolveStructuredTokenBudget(options, stage, unitCount) {
  const configured = Math.max(256, Number(options.maxTokens) || 4096);
  if (stage === "grouping") {
    const requested =
      192 + Math.max(0, unitCount) * SEMANTIC_GROUPING_TOKENS_PER_UNIT;
    const requestedCap = Math.max(256, requested);
    return {
      maxTokens: Math.min(configured, requestedCap),
      source:
        configured <= requestedCap
          ? "max-output-tokens"
          : "structured-request-budget",
    };
  }

  const attempt = Math.max(
    1,
    Math.trunc(Number(options.translationAttempt) || 1),
  );
  const retryScale = Math.min(
    SEMANTIC_TRANSLATION_MAX_RETRY_SCALE,
    2 ** Math.min(2, attempt - 1),
  );
  const requested =
    (SEMANTIC_TRANSLATION_BASE_TOKENS +
      Math.max(1, unitCount) * SEMANTIC_TRANSLATION_TOKENS_PER_UNIT +
      (options.collectPageContext ? SEMANTIC_PAGE_CONTEXT_TOKENS : 0)) *
    retryScale;
  const budgetHeadroom = Number(
    options.workContextBudget?.effective?.outputHeadroomTokens,
  );
  const contextTokens = Number(options.ctx);
  const contextHeadroom =
    Number.isFinite(contextTokens) && contextTokens > 0
      ? contextTokens - SEMANTIC_TRANSLATION_INPUT_RESERVE_TOKENS
      : Number.NaN;
  const outputHeadroom = Number.isFinite(budgetHeadroom)
    ? budgetHeadroom
    : contextHeadroom;
  const safeCap = Number.isFinite(outputHeadroom)
    ? Math.max(256, Math.trunc(outputHeadroom))
    : configured;
  const requestedCap = Math.max(768, requested);
  const maxTokens = Math.min(configured, safeCap, requestedCap);
  return {
    maxTokens,
    source: resolveTranslationTokenLimitSource(
      options,
      configured,
      safeCap,
      requestedCap,
    ),
  };
}

/**
 * @param {SemanticRequestOptions} options
 * @param {number} configured
 * @param {number} safeCap
 * @param {number} requestedCap
 */
function resolveTranslationTokenLimitSource(
  options,
  configured,
  safeCap,
  requestedCap,
) {
  if (configured <= safeCap && configured <= requestedCap) {
    return "max-output-tokens";
  }
  if (safeCap < configured && safeCap <= requestedCap) {
    return options.modelProvider === "gemma"
      ? "context-length"
      : "work-context-budget";
  }
  return "structured-request-budget";
}

module.exports = {
  SEMANTIC_REPEAT_LAST_N,
  SEMANTIC_REPEAT_PENALTY,
  SEMANTIC_SEED,
  buildSemanticImageMessages,
  buildSemanticStageRequestBody,
  resolveOutputTruncationDetail,
  resolveStructuredTokenBudget,
};
