// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & { [key: string]: unknown }} TranslationRequestOptions
 * @typedef {{ baseUrl: string; [key: string]: unknown }} ModelServer
 */

const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredCodexReasoningEffort,
} = require("../simple-page-model-config.cjs");
const { inspectModelLaunch } = require("../simple-page-model-assets.cjs");
const {
  applyLocalForbiddenTokenBias,
} = require("../simple-page-logit-bias.cjs");
const {
  resolveRequestModelName,
} = require("../simple-page-request-summary.cjs");
const {
  buildChatRequestHeaders,
} = require("../simple-page-request-builders.cjs");
const { createDetailedError } = require("./model-runtime-services.cjs");
const {
  createEmptyOutputError,
  createHttpFailureError,
  createModelTransportError,
  truncateSensitiveText,
} = require("./model-http-errors.cjs");
const { runWithApiKeyRetry } = require("./api-key-retry.cjs");
const {
  readCodexResponsesStream,
  readResponseText,
} = require("./model-response-readers.cjs");
const { buildChatRequestBody } = require("./request-bodies.cjs");
const { createLinkedDeadlineController } = require("./http-deadline.cjs");

const VISION_PROBE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function testModelReply(server, options) {
  const deadline = createLinkedDeadlineController(
    options.abortSignal,
    30000,
    "Model probe",
  );
  const boundedOptions = { ...options, abortSignal: deadline.signal };
  try {
    if (isOpenAICodexProvider(boundedOptions)) {
      return await testCodexResponsesReply(server, boundedOptions);
    }

    const requestBody = buildChatRequestBody(
      boundedOptions,
      buildProbeMessages(),
      48,
    );
    if (!isOpenAIApiProvider(boundedOptions)) {
      await applyLocalForbiddenTokenBias(server, boundedOptions, requestBody);
    }
    const outputText = await runWithApiKeyRetry(
      boundedOptions,
      async (apiKey) => {
        const response = await sendProbeRequest(
          server,
          boundedOptions,
          requestBody,
          apiKey,
        );
        const rawText = await readResponseText(response, {}, boundedOptions);
        if (!response.ok) {
          throw createHttpFailureError(boundedOptions, {}, response, rawText);
        }

        const parsed = parseProbeResponse(rawText, boundedOptions);
        const output = extractProbeOutput(parsed);
        if (!output) {
          throw createEmptyOutputError(parsed, rawText, {}, boundedOptions);
        }
        return output;
      },
    );
    return { outputText, launchTarget: inspectModelLaunch(boundedOptions) };
  } finally {
    deadline.cleanup();
  }
}

function buildProbeMessages() {
  return [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: "Confirm that you can inspect the attached image. Reply in one short sentence.",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: VISION_PROBE_DATA_URL },
        },
        {
          type: "text",
          text: "Inspect this 1x1 PNG, then say 'model test ok'.",
        },
      ],
    },
  ];
}

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @param {Record<string, unknown>} requestBody
 * @param {string | undefined} apiKey
 */
async function sendProbeRequest(server, options, requestBody, apiKey) {
  try {
    return await fetch(`${server.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildChatRequestHeaders(options, apiKey),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal,
    });
  } catch (error) {
    throw createModelTransportError(
      "모델 테스트 요청을 보내지 못했습니다.",
      { requestBody: { ...requestBody, messages: requestBody.messages } },
      error,
    );
  }
}

/** @param {string} rawText @param {TranslationRequestOptions} options */
function parseProbeResponse(rawText, options) {
  try {
    return /** @type {unknown} */ (JSON.parse(rawText));
  } catch (error) {
    throw createDetailedError(
      "모델 테스트 응답을 JSON으로 읽지 못했습니다.",
      { rawTextPreview: truncateSensitiveText(rawText, options, 4000) },
      error,
    );
  }
}

/** @param {unknown} parsed */
function extractProbeOutput(parsed) {
  const root = asRecord(parsed);
  const choices = root && Array.isArray(root.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map(readTextPart).join("\n").trim();
}

/** @param {unknown} value */
function readTextPart(value) {
  const record = asRecord(value);
  return String(record?.text || "");
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 */
async function testCodexResponsesReply(server, options) {
  const requestBody = buildCodexProbeRequest(options);
  const response = await sendCodexProbeRequest(server, options, requestBody);
  if (!response.ok) {
    const rawText = await readResponseText(response, {}, options);
    throw createHttpFailureError(options, {}, response, rawText);
  }
  const result = await readCodexResponsesStream(response, {}, options);
  return {
    outputText: result.outputText,
    launchTarget: inspectModelLaunch(options),
  };
}

/** @param {TranslationRequestOptions} options */
function buildCodexProbeRequest(options) {
  return {
    model: resolveRequestModelName(options),
    instructions: "Reply in one short sentence.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say 'model test ok'." }],
      },
    ],
    reasoning: { effort: resolveConfiguredCodexReasoningEffort(options) },
    stream: true,
    store: false,
  };
}

/**
 * @param {ModelServer} server
 * @param {TranslationRequestOptions} options
 * @param {Record<string, unknown>} requestBody
 */
async function sendCodexProbeRequest(server, options, requestBody) {
  try {
    return await fetch(`${server.baseUrl}/responses`, {
      method: "POST",
      headers: buildChatRequestHeaders(options),
      body: JSON.stringify(requestBody),
      signal: options.abortSignal,
    });
  } catch (error) {
    throw createModelTransportError(
      "모델 테스트 요청을 보내지 못했습니다.",
      { requestBody },
      error,
    );
  }
}

module.exports = {
  testModelReply,
};
