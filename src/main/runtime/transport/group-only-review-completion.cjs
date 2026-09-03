// @ts-check

const { buildRequestSummary } = require("../simple-page-request-summary.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
} = require("../simple-page-model-config.cjs");
const {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  GROUP_ONLY_REVIEW_VERSION,
} = require("../semantic-ocr/group-only-review.cjs");
const { nowMs } = require("./model-runtime-services.cjs");
const {
  buildSemanticStageRequestBody,
} = require("./semantic-ocr-request-builders.cjs");
const { requestStructuredCompletion } = require("./structured-completion.cjs");

/**
 * @typedef {Record<string,unknown>} JsonRecord
 * @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer
 * @typedef {{maxTokens?:unknown;ocrBboxHints:JsonRecord[];[key:string]:unknown}} ReviewOptions
 * @typedef {{role:string;path:string;dataUrl?:string;semanticReviewCropId?:unknown;[key:string]:unknown}} ImageVariant
 */

/**
 * @param {ModelServer} server
 * @param {ReviewOptions} options
 * @param {JsonRecord} payload
 * @param {ImageVariant} variant
 * @param {number} requestVersion
 */
async function requestGroupOnlyCropCompletion(
  server,
  options,
  payload,
  variant,
  requestVersion,
) {
  const prompt = String(payload.prompt ?? "");
  const systemPrompt = String(payload.systemPrompt ?? "");
  const candidateOrder = Array.isArray(payload.candidateOrder)
    ? payload.candidateOrder
    : [];
  const requestOptions = {
    ...options,
    ocrBboxHints: readCaseCandidates(payload.case),
  };
  const summary = buildRequestSummary(
    server,
    requestOptions,
    [variant],
    prompt,
    systemPrompt,
  );
  Object.assign(summary, {
    semanticGroupReviewRequestVersion: requestVersion,
    semanticGroupReviewContractVersion: GROUP_ONLY_REVIEW_VERSION,
    semanticGroupReviewPromptContractVersion:
      GROUP_ONLY_PROMPT_CONTRACT_VERSION,
    semanticGroupReviewCropId: variant.semanticReviewCropId,
    semanticGroupReviewCandidateCount: candidateOrder.length,
  });
  const body = buildRequestBody(
    options,
    variant,
    prompt,
    systemPrompt,
    /** @type {JsonRecord} */ (payload.responseFormat),
    candidateOrder.length,
  );
  const startedAt = nowMs();
  const result = await requestStructuredCompletion(
    server,
    options,
    body,
    summary,
    startedAt,
  );
  summary.semanticGroupReviewForbiddenTokenBias = result.forbiddenTokenBias;
  return {
    outputText: result.response.outputText,
    rawResponse: result.response.rawResponse,
  };
}

/**
 * @param {ReviewOptions} options @param {ImageVariant} variant
 * @param {string} prompt @param {string} systemPrompt
 * @param {JsonRecord} responseFormat @param {number} count
 */
function buildRequestBody(
  options,
  variant,
  prompt,
  systemPrompt,
  responseFormat,
  count,
) {
  const messages = [
    { role: "system", content: [{ type: "text", text: systemPrompt }] },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: variant.dataUrl } },
        {
          type: "text",
          text: "Image 1 is the clean crop. The JSON below contains PaddleOCR line IDs, text guesses, and exact crop-relative boxes.",
        },
        { type: "text", text: prompt },
      ],
    },
  ];
  const body = /** @type {JsonRecord} */ (
    buildSemanticStageRequestBody(
      options,
      messages,
      responseFormat,
      "grouping",
      count,
    )
  );
  const maxOutputTokens = Math.min(
    900,
    Math.max(256, positiveInteger(options.maxTokens) || 4096),
  );
  if (isOpenAICodexProvider(options)) {
    body.max_output_tokens = maxOutputTokens;
  } else {
    body.max_tokens = maxOutputTokens;
  }
  if (!isOpenAIApiProvider(options) && !isOpenAICodexProvider(options)) {
    body.repeat_penalty = 1.05;
  }
  return body;
}

/** @param {unknown} value */
function readCaseCandidates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidates = /** @type {JsonRecord} */ (value).candidates;
  return Array.isArray(candidates) ? candidates : [];
}

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

module.exports = { requestGroupOnlyCropCompletion };
