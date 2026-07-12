// @ts-check

const { parseLooseItemList } = require("./loose-overlay-items.cjs");
const { validateRegionSingleItemPayload } = require("./overlay-items.cjs");

const SPECIAL_TOKEN_PATTERN =
  /<\/?(?:unused\d+|start_of_turn|end_of_turn|eos|bos|pad|mask|unk)>/gi;

/** @param {string} rawText */
function stripModelSpecialTokens(rawText) {
  return rawText.replace(SPECIAL_TOKEN_PATTERN, "");
}

/** @param {string} rawText */
function extractJsonCandidate(rawText) {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const objectCandidate = findDelimitedCandidate(trimmed, "{", "}");
  if (objectCandidate) {
    return objectCandidate;
  }
  const arrayCandidate = findDelimitedCandidate(trimmed, "[", "]");
  if (arrayCandidate) {
    return arrayCandidate;
  }
  throw new Error("Could not find a JSON object in the model output.");
}

/** @param {string} text @param {string} opening @param {string} closing */
function findDelimitedCandidate(text, opening, closing) {
  const first = text.indexOf(opening);
  const last = text.lastIndexOf(closing);
  return first !== -1 && last > first ? text.slice(first, last + 1) : "";
}

/** @param {string} rawText @returns {unknown} */
function parseJsonLenient(rawText) {
  const text = stripModelSpecialTokens(rawText);
  const candidate = findCandidateOrLoosePayload(text);
  if (typeof candidate !== "string") {
    return candidate;
  }
  for (const attempt of buildRepairAttempts(candidate)) {
    const parsed = tryParseStructuredItems(attempt);
    if (parsed !== null) {
      return parsed;
    }
  }
  return parseLooseFallbacks(text, candidate);
}

/** @param {string} text @returns {string | { items: unknown[] }} */
function findCandidateOrLoosePayload(text) {
  try {
    return extractJsonCandidate(text);
  } catch (error) {
    const looseItems = parseLooseItemList(text);
    if (looseItems.length > 0) {
      return { items: looseItems };
    }
    throw new Error(
      "Failed to find a parseable structured payload in the model output.",
      { cause: error },
    );
  }
}

/** @param {string} candidate */
function buildRepairAttempts(candidate) {
  return [
    candidate,
    candidate.replace(/,\s*([}\]])/g, "$1"),
    repairBrokenJson(candidate),
  ];
}

/** @param {string} candidate @returns {unknown | null} */
function tryParseStructuredItems(candidate) {
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(candidate));
    return hasStructuredItems(parsed) ? parsed : null;
  } catch (_error) {
    // error-policy-allow: lenient parsing deliberately tries the next documented repair pass.
    return null;
  }
}

/** @param {string} text @param {string} candidate */
function parseLooseFallbacks(text, candidate) {
  for (const value of [text, candidate]) {
    const looseItems = parseLooseItemList(value);
    if (looseItems.length > 0) {
      return { items: looseItems };
    }
  }
  throw new Error("Failed to parse model output as JSON.");
}

/**
 * @param {string} rawText
 * @returns {{ item: unknown | null }}
 */
function parseRegionSingleItem(rawText) {
  const candidate = extractRegionCandidate(stripModelSpecialTokens(rawText));
  /** @type {unknown} */
  let lastError = null;
  for (const attempt of buildRepairAttempts(candidate)) {
    try {
      return validateRegionSingleItemPayload(JSON.parse(attempt));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    'Region response contract violation: expected { "item": {...} } or { "item": null }.',
    { cause: lastError },
  );
}

/** @param {string} text */
function extractRegionCandidate(text) {
  try {
    return extractJsonCandidate(text);
  } catch (error) {
    throw new Error(
      "Region response contract violation: JSON object missing.",
      { cause: error },
    );
  }
}

/** @param {unknown} parsed */
function hasStructuredItems(parsed) {
  if (Array.isArray(parsed)) {
    return true;
  }
  const record =
    parsed && typeof parsed === "object"
      ? /** @type {{ items?: unknown; blocks?: unknown }} */ (parsed)
      : {};
  return Array.isArray(record.items) || Array.isArray(record.blocks);
}

/** @param {string} candidate */
function repairBrokenJson(candidate) {
  let repaired = candidate
    .trim()
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  repaired = repairKnownKeys(repaired);
  repaired = repaired.replace(
    /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g,
    /** @param {string} _ @param {string} prefix @param {string} key */
    (_, prefix, key) => `${prefix}"${key}":`,
  );
  repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');
  repaired = repaired.replace(
    /("id"\s*:\s*)([A-Za-z]+)(\s*[,\n}])/g,
    '$1"$2"$3',
  );
  repaired = repairUnquotedTextValues(repaired);
  return repaired
    .replace(/"(x1|y1|x2|y2)\s*:/g, '"$1":')
    .replace(/([{\s,])(x1|y1|x2|y2)\s*:/g, '$1"$2":')
    .replace(/"ko\s*:/g, '"ko":')
    .replace(/,\s*([}\]])/g, "$1");
}

/** @param {string} candidate */
function repairKnownKeys(candidate) {
  return candidate.replace(
    /"?(id|type|textRole|text_role|bbox|jp|ko|sourceText|translatedText|source|target|direction|angle|fontSize|confidence|x1|y1|x2|y2)(?::|\s*:)/gi,
    /** @param {string} _ @param {string} key */
    (_, key) => `"${normalizeRepairedJsonKey(key)}":`,
  );
}

/** @param {string} candidate */
function repairUnquotedTextValues(candidate) {
  return candidate.replace(
    /("(?:jp|ko|source|target|sourceText|translatedText|type)"\s*:\s*)([^"{[\n][^,\n}]*)/g,
    /** @param {string} _match @param {string} prefix @param {string} value */
    (_match, prefix, value) => {
      const trimmed = String(value).trim();
      if (!trimmed || /^"/.test(trimmed)) {
        return `${prefix}${trimmed}`;
      }
      return `${prefix}"${trimmed.replace(/^['"]|['"]$/g, "")}"`;
    },
  );
}

/** @param {string} key */
function normalizeRepairedJsonKey(key) {
  const lower = key.toLowerCase();
  const aliases = {
    fontsize: "fontSize",
    textrole: "textRole",
    text_role: "textRole",
    sourcetext: "sourceText",
    translatedtext: "translatedText",
  };
  return /** @type {Record<string, string>} */ (aliases)[lower] ?? lower;
}

module.exports = {
  extractJsonCandidate,
  parseJsonLenient,
  parseRegionSingleItem,
  repairBrokenJson,
  stripModelSpecialTokens,
};
