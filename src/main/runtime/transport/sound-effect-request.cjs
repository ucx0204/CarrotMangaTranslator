// @ts-check

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & {[key:string]:unknown}} SoundEffectOptions */
/** @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer */
/** @typedef {{promptOptions:SoundEffectOptions;requestBody:Record<string,unknown>;requestSummary:Record<string,unknown>}} PreparedRequest */
const {
  buildSoundEffectTranslationResponseFormat,
} = require("../semantic-ocr/sound-effect-translation.cjs");
const {
  buildSemanticStageRequestBody,
  resolveStructuredTokenBudget,
} = require("./semantic-ocr-request-builders.cjs");
const { requestStructuredCompletion } = require("./structured-completion.cjs");

/** Use the same provider schemas, local reasoning limits and credential handling
 * as other fixed-target translations, retaining the dedicated SFX wire format.
 * @param {SoundEffectOptions} options
 * @param {Array<Record<string,unknown>>} messages
 */
function buildSoundEffectRequestBody(options, messages) {
  return buildSemanticStageRequestBody(
    options,
    messages,
    buildSoundEffectTranslationResponseFormat(options),
    "translation",
    1,
  );
}

/** @param {ModelServer} server @param {PreparedRequest} prepared
 * @param {number} requestStartedAt
 */
async function requestSoundEffectCompletion(
  server,
  prepared,
  requestStartedAt,
) {
  const { promptOptions, requestBody, requestSummary } = prepared;
  const budget = resolveStructuredTokenBudget(promptOptions, "translation", 1);
  Object.assign(requestSummary, {
    responseMaxTokens: budget.maxTokens,
    responseTokenLimitSource: budget.source,
  });
  const result = await requestStructuredCompletion(
    server,
    promptOptions,
    requestBody,
    requestSummary,
    requestStartedAt,
  );
  if (result.forbiddenTokenBias)
    requestSummary.localForbiddenTokenBias = result.forbiddenTokenBias;
  return result.response;
}

module.exports = { buildSoundEffectRequestBody, requestSoundEffectCompletion };
