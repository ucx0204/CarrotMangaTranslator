// @ts-check

const MAX_OCR_CANDIDATES = 80;
const GEMMA_CHANNEL_PREFIX_PATTERN =
  /^<\|channel\|?>(?:thought|analysis|final)\s*(?:<channel\|>|<\|message\|?>)\s*/i;
const GEMMA_TURN_PREFIX_PATTERN =
  /^(?:<\|start\|>\s*assistant|<start_of_turn>\s*model)\s*/i;
const GEMMA_TRAILING_CONTROL_PATTERN =
  /\s*(?:<\|end\|>|<\|end_of_turn\|>|<end_of_turn>|<\|eot_id\|>)\s*$/i;

/** @param {unknown} value */
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** @param {string} rawText @param {string} label */
function parseJsonObject(rawText, label) {
  const cleaned = normalizeJsonObjectEnvelope(rawText);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw semanticContractError(
      "semantic-ocr-json-invalid",
      `${label} did not return valid JSON.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw semanticContractError(
      "semantic-ocr-json-invalid",
      `${label} must return one JSON object.`,
    );
  }
  return parsed;
}

/**
 * Remove only known code fences and Gemma boundary markers. The complete
 * remaining value must still be one JSON object.
 *
 * @param {unknown} rawText
 */
function normalizeJsonObjectEnvelope(rawText) {
  let cleaned = String(rawText ?? "").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const previous = cleaned;
    cleaned = stripGemmaBoundaryControls(cleaned)
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    if (cleaned === previous) break;
  }
  return cleaned;
}

/** @param {string} value */
function stripGemmaBoundaryControls(value) {
  let cleaned = value.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const previous = cleaned;
    cleaned = cleaned
      .replace(GEMMA_TURN_PREFIX_PATTERN, "")
      .replace(GEMMA_CHANNEL_PREFIX_PATTERN, "")
      .replace(GEMMA_TRAILING_CONTROL_PATTERN, "")
      .trim();
    if (cleaned === previous) break;
  }
  return cleaned;
}

/** @param {unknown} value @param {number} maxChars */
function cleanText(value, maxChars) {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 */
function semanticContractError(code, message, detail = {}) {
  const error = new Error(message);
  Object.assign(error, { code, ...detail });
  return error;
}

module.exports = {
  MAX_OCR_CANDIDATES,
  cleanText,
  isRecord,
  parseJsonObject,
  positiveInteger,
  semanticContractError,
};
