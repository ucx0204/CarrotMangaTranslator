// @ts-check
/**
 * @typedef {{ x: number; y: number; w: number; h: number }} ParsedBbox
 * @typedef {{ id: number; candidateIds?: number[]; type: string; x1?: number; y1?: number; x2?: number; y2?: number; jp: string; ko: string; sourceText?: string; translatedText?: string; textRole?: string; direction?: "horizontal" | "vertical"; angle?: number; fontSize?: number | null; confidence?: number | null }} LooseParsedOutput
 */

const { asRecord, normalizeBBox, toNumber } = require("./overlay-geometry.cjs");
const {
  isPlaceholderOnly,
  normalizeAngle,
  normalizeConfidence,
  normalizeDirection,
  normalizeFontSize,
  normalizeParsedType,
  normalizeTextField,
  normalizeTextRole,
} = require("./overlay-values.cjs");

const TRANSLATED_TEXT_KEYS = [
  "ko",
  "target",
  "translatedText",
  "korean",
  "translation",
  "translated",
  "text_ko",
];
const SOURCE_TEXT_KEYS = [
  "jp",
  "source",
  "sourceText",
  "japanese",
  "ocr",
  "text_jp",
];

/**
 * @param {unknown} parsed
 * @returns {{ item: unknown | null }}
 */
function validateRegionSingleItemPayload(parsed) {
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(
      "Region response contract violation: top-level object required.",
    );
  }
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "item") {
    throw new Error(
      "Region response contract violation: exactly one item key required.",
    );
  }
  if (record.item === null) {
    return { item: null };
  }
  if (!asRecord(record.item)) {
    throw new Error(
      "Region response contract violation: item must be an object or null.",
    );
  }
  return { item: record.item };
}

/**
 * @param {unknown} item
 * @param {number} index
 * @returns {(LooseParsedOutput & { bbox: ParsedBbox }) | null}
 */
function normalizeItem(item, index) {
  const record = asRecord(item) ?? {};
  const normalizedKo = normalizeTextField(
    findFirstText(record, TRANSLATED_TEXT_KEYS),
  );
  const normalizedJp = normalizeTextField(
    findFirstText(record, SOURCE_TEXT_KEYS),
  );
  const bbox = normalizeBBox(record);
  if (!normalizedKo || !bbox) {
    return null;
  }
  if (isOnlyPlaceholderPair(normalizedKo, normalizedJp)) {
    return null;
  }
  return buildNormalizedItem(record, index, bbox, normalizedJp, normalizedKo);
}

/** @param {Record<string, unknown>} record @param {string[]} keys */
function findFirstText(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

/** @param {string} translated @param {string} source */
function isOnlyPlaceholderPair(translated, source) {
  return (
    isPlaceholderOnly(translated) && (!source || isPlaceholderOnly(source))
  );
}

/**
 * @param {Record<string, unknown>} record
 * @param {number} index
 * @param {ParsedBbox} bbox
 * @param {string} sourceText
 * @param {string} translatedText
 */
function buildNormalizedItem(record, index, bbox, sourceText, translatedText) {
  const textRole = normalizeTextRole(
    record.textRole ?? record.text_role ?? record.role,
  );
  return {
    id: toNumber(record.id) ?? index + 1,
    ...readCandidateIds(record.candidateIds),
    type: normalizeParsedType(record.type),
    ...(textRole ? { textRole } : {}),
    bbox,
    // jp/ko는 하위 호환 별칭이고 sourceText/translatedText가 중립 명칭이다.
    jp: sourceText,
    ko: translatedText,
    sourceText,
    translatedText,
    direction: normalizeDirection(
      record.direction ?? record.sourceDirection ?? record.writingDirection,
    ),
    angle: normalizeAngle(
      record.angle ?? record.rotation ?? record.rotationDeg,
    ),
    fontSize: normalizeFontSize(
      record.fontSize ?? record.font_size ?? record.font,
    ),
    confidence: normalizeConfidence(record.confidence ?? record.score),
  };
}

/** @param {unknown} value */
function readCandidateIds(value) {
  if (!Array.isArray(value)) {
    return {};
  }
  const ids = value
    .map((candidate) => Number(candidate))
    .filter((candidate) => Number.isInteger(candidate) && candidate > 0);
  return ids.length === value.length && new Set(ids).size === ids.length
    ? { candidateIds: ids }
    : {};
}

/**
 * @param {unknown} parsed
 * @returns {Array<LooseParsedOutput & { bbox: ParsedBbox }>}
 */
function normalizeItems(parsed) {
  return resolveParsedItems(parsed)
    .map((item, index) => normalizeItem(item, index))
    .filter((item) => item !== null);
}

/** @param {unknown} parsed @returns {unknown[]} */
function resolveParsedItems(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  const record = asRecord(parsed);
  if (Array.isArray(record?.items)) {
    return record.items;
  }
  return Array.isArray(record?.blocks) ? record.blocks : [];
}

/**
 * @param {unknown} parsed
 * @returns {Array<LooseParsedOutput & { bbox: ParsedBbox }>}
 */
function normalizeRegionSingleItem(parsed) {
  const payload = validateRegionSingleItemPayload(parsed);
  if (payload.item === null) {
    return [];
  }
  const itemRecord = /** @type {Record<string, unknown>} */ (payload.item);
  const normalized = normalizeItem(
    {
      ...itemRecord,
      id: 1,
      type: itemRecord.type || "nonsolid",
      textRole: itemRecord.textRole || itemRecord.text_role || "ordinary",
    },
    0,
  );
  if (!normalized) {
    throw new Error(
      "Region response contract violation: item object is incomplete.",
    );
  }
  return [
    {
      ...normalized,
      id: 1,
      type: "nonsolid",
      textRole: normalized.textRole || "ordinary",
    },
  ];
}

module.exports = {
  normalizeItems,
  normalizeRegionSingleItem,
  validateRegionSingleItemPayload,
};
