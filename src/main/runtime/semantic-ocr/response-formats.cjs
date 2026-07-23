// @ts-check

// llama.cpp applies JSON Schema patterns to the serialized string contents,
// so `^[^\r\n]+$` would still admit a raw `\n` escape. Overlay text does not
// need JSON escapes: ordinary Unicode punctuation (including curly quotes) is
// available directly. Keeping this grammar to printable, unescaped content
// prevents both decoded line breaks and JSON-like escape workarounds.
const SINGLE_LINE_JSON_STRING_PATTERN = String.raw`^[^"\\\u0000-\u001F]+$`;

/**
 * The common fixed-block path deliberately exposes no geometry or grouping
 * fields in its output grammar. `blockId` is an opaque code-owned slot id,
 * separate from OCR candidate ids. Source text and every visual property are
 * immutable inputs; the translator may return only the Korean translation.
 *
 * @param {string[]} blockIds
 * @param {{collectPageContext?: unknown}} [options]
 */
function buildFixedBlockTranslationResponseFormat(blockIds, options = {}) {
  const properties = {
    items: {
      type: "array",
      minItems: blockIds.length,
      maxItems: blockIds.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["blockId", "ko"],
        properties: {
          blockId: { type: "string", enum: blockIds },
          ko: singleLineNonEmptyStringSchema(),
        },
      },
    },
    ...(options.collectPageContext ? { pageContext: pageContextSchema() } : {}),
  };
  return {
    type: "json_object",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties,
    },
  };
}

function pageContextSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["visualSummary", "glossary", "characters"],
    properties: {
      visualSummary: stringSchema(),
      glossary: {
        type: "array",
        maxItems: 24,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["source", "target", "category", "aliases", "note"],
          properties: {
            source: nonEmptyStringSchema(),
            target: stringSchema(),
            category: {
              type: "string",
              enum: [
                "character",
                "alias",
                "place",
                "term",
                "honorific",
                "other",
              ],
            },
            aliases: stringArraySchema(12),
            note: stringSchema(),
          },
        },
      },
      characters: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "displayName",
            "sourceNames",
            "targetName",
            "aliases",
            "speechStyle",
            "customSpeechStyle",
            "note",
          ],
          properties: {
            displayName: nonEmptyStringSchema(),
            sourceNames: stringArraySchema(12),
            targetName: stringSchema(),
            aliases: stringArraySchema(12),
            speechStyle: {
              type: "string",
              enum: [
                "neutral",
                "polite",
                "casual",
                "rough",
                "childish",
                "elderly",
                "formal",
                "custom",
              ],
            },
            customSpeechStyle: stringSchema(),
            note: stringSchema(),
          },
        },
      },
    },
  };
}

/**
 * Do not add maxLength to schemas sent to local llama.cpp-compatible
 * runtimes. Their JSON-schema-to-GBNF conversion expands it to char{0,N},
 * and some Gemma 4 runtimes reject large repetition ranges before sampling.
 * Output tokens and the runtime parsers provide the actual size bounds.
 */
function stringSchema() {
  return { type: "string" };
}

function nonEmptyStringSchema() {
  return { type: "string", minLength: 1 };
}

function singleLineNonEmptyStringSchema() {
  return { type: "string", pattern: SINGLE_LINE_JSON_STRING_PATTERN };
}

/** @param {number} maxItems */
function stringArraySchema(maxItems) {
  return {
    type: "array",
    maxItems,
    items: stringSchema(),
  };
}

module.exports = {
  buildFixedBlockTranslationResponseFormat,
};
