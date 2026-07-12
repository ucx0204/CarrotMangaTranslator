// @ts-check
/**
 * @typedef {Record<string, unknown>} JsonRecord
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} OcrBox
 * @typedef {OcrBox & { id?: number; label?: string; ocrText?: string; score?: number; [key: string]: unknown }} OcrHint
 * @typedef {{ imageWidth?: unknown; imageHeight?: unknown; sourceLanguage?: unknown; [key: string]: unknown }} OcrHintOptions
 */
const {
  readOcrCandidateText,
  readPositiveInteger,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
} = require("../simple-page-prompts.cjs");
const { attachOcrGroupingHints } = require("./hint-grouping.cjs");
const { asRecord, readRawOcrBox } = require("./hint-boxes.cjs");

const IGNORED_LABELS = new Set([
  "image",
  "header_image",
  "footer_image",
  "chart",
  "table",
  "figure",
  "seal",
  "formula",
  "display_formula",
  "inline_formula",
  "number",
  "footer",
  "header",
]);

/** @param {unknown} rawText */
function extractJsonText(rawText) {
  const text = String(rawText ?? "").trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    return text;
  }
  const objectRange = findJsonRange(text, "{", "}");
  const arrayRange = findJsonRange(text, "[", "]");
  if (objectRange && (!arrayRange || objectRange.start < arrayRange.start)) {
    return text.slice(objectRange.start, objectRange.end + 1);
  }
  return arrayRange ? text.slice(arrayRange.start, arrayRange.end + 1) : "";
}

/**
 * @param {string} text
 * @param {string} open
 * @param {string} close
 */
function findJsonRange(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start !== -1 && end > start ? { start, end } : null;
}

/**
 * @param {unknown} payload
 * @param {OcrHintOptions} [options]
 * @returns {OcrHint[]}
 */
function normalizeOcrBboxHintPayload(payload, options = {}) {
  const imageWidth = readPositiveInteger(options.imageWidth);
  const imageHeight = readPositiveInteger(options.imageHeight);
  /** @type {OcrHint[]} */
  const hints = [];
  for (const candidate of collectOcrBboxCandidates(payload)) {
    const hint = normalizeCandidate(
      candidate,
      payload,
      options,
      imageWidth,
      imageHeight,
    );
    if (hint) {
      hints.push({ ...hint, id: hints.length + 1 });
    }
  }
  return attachOcrGroupingHints(hints, {
    imageWidth,
    imageHeight,
    sourceLanguage: options.sourceLanguage,
  }).slice(0, 80);
}

/**
 * @param {unknown} candidate
 * @param {unknown} payload
 * @param {OcrHintOptions} options
 * @param {number | null} imageWidth
 * @param {number | null} imageHeight
 * @returns {OcrHint | null}
 */
function normalizeCandidate(
  candidate,
  payload,
  options,
  imageWidth,
  imageHeight,
) {
  const record = asRecord(candidate);
  const box = normalizeOcrBboxCandidate(
    candidate,
    imageWidth,
    imageHeight,
    payload,
  );
  const label = readCandidateLabel(record);
  if (!box || isIgnoredOcrLabel(label)) {
    return null;
  }
  const hint = /** @type {OcrHint} */ ({
    label: sanitizeHintLabel(label),
    ...box,
  });
  const score = readCandidateScore(record);
  if (score !== null) {
    hint.score = score;
  }
  const ocrText = sanitizeOcrTextForPrompt(
    readOcrCandidateText(candidate),
    options,
  );
  if (ocrText) {
    hint.ocrText = ocrText;
  }
  return hint;
}

/** @param {JsonRecord} record */
function readCandidateLabel(record) {
  return (
    record.label ??
    record.type ??
    record.category ??
    record.class ??
    record.class_name ??
    "text"
  );
}

/** @param {JsonRecord} record */
function readCandidateScore(record) {
  const score = Number(record.score ?? record.confidence);
  return Number.isFinite(score) ? score : null;
}

/**
 * @param {unknown} payload
 * @returns {unknown[]}
 */
function collectOcrBboxCandidates(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  const direct = firstArray([
    record.items,
    record.blocks,
    record.parsing_res_list,
    asRecord(record.layout_det_res).boxes,
  ]);
  if (direct) {
    return direct;
  }
  const nested = firstArray([record.pages, record.results]);
  if (nested) {
    return nested.flatMap(collectOcrBboxCandidates);
  }
  const child = firstObject([record.result, record.data]);
  return child ? collectOcrBboxCandidates(child) : [];
}

/** @param {unknown[]} values */
function firstArray(values) {
  return values.find(Array.isArray);
}

/** @param {unknown[]} values */
function firstObject(values) {
  return values.find((value) => value && typeof value === "object");
}

/**
 * @param {unknown} candidate
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 * @param {unknown} payload
 * @returns {OcrBox | null}
 */
function normalizeOcrBboxCandidate(
  candidate,
  originalWidth,
  originalHeight,
  payload,
) {
  const rawBox = readRawOcrBox(candidate);
  if (!rawBox) {
    return null;
  }
  const scale = resolveCoordinateScale(
    asRecord(candidate),
    asRecord(payload),
    originalWidth,
    originalHeight,
  );
  return clampBox(scaleBox(rawBox, scale), originalWidth, originalHeight);
}

/**
 * @param {JsonRecord} candidate
 * @param {JsonRecord} payload
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 */
function resolveCoordinateScale(
  candidate,
  payload,
  originalWidth,
  originalHeight,
) {
  const space = readCoordinateSpace(payload, candidate);
  if (space.includes("1000") && originalWidth && originalHeight) {
    return { x: originalWidth / 1000, y: originalHeight / 1000 };
  }
  const sourceWidth = readSourceDimension(
    payload.width ?? payload.imageWidth ?? candidate.imageWidth,
    originalWidth,
  );
  const sourceHeight = readSourceDimension(
    payload.height ?? payload.imageHeight ?? candidate.imageHeight,
    originalHeight,
  );
  if (!sourceWidth || !sourceHeight || !originalWidth || !originalHeight) {
    return { x: 1, y: 1 };
  }
  return {
    x: originalWidth / sourceWidth,
    y: originalHeight / sourceHeight,
  };
}

/** @param {JsonRecord} payload @param {JsonRecord} candidate */
function readCoordinateSpace(payload, candidate) {
  const values = [
    payload.coordinateSpace,
    payload.bboxCoordinateSpace,
    candidate.coordinateSpace,
  ];
  return String(
    values.find((value) => value !== null && value !== undefined) ?? "",
  ).toLowerCase();
}

/** @param {unknown} value @param {number | null} fallback */
function readSourceDimension(value, fallback) {
  return readPositiveInteger(value) || fallback;
}

/** @param {OcrBox} box @param {{ x: number; y: number }} scale */
function scaleBox(box, scale) {
  return {
    x1: box.x1 * scale.x,
    y1: box.y1 * scale.y,
    x2: box.x2 * scale.x,
    y2: box.y2 * scale.y,
  };
}

/**
 * @param {OcrBox} box
 * @param {number | null} width
 * @param {number | null} height
 * @returns {OcrBox | null}
 */
function clampBox(box, width, height) {
  const x1 = Math.max(0, Math.round(Math.min(box.x1, box.x2)));
  const y1 = Math.max(0, Math.round(Math.min(box.y1, box.y2)));
  const rawX2 = Math.round(Math.max(box.x1, box.x2));
  const rawY2 = Math.round(Math.max(box.y1, box.y2));
  const x2 = width ? Math.min(width, rawX2) : rawX2;
  const y2 = height ? Math.min(height, rawY2) : rawY2;
  return x2 - x1 >= 2 && y2 - y1 >= 2 ? { x1, y1, x2, y2 } : null;
}

/** @param {unknown} label */
function isIgnoredOcrLabel(label) {
  return IGNORED_LABELS.has(sanitizeHintLabel(label));
}

module.exports = { extractJsonText, normalizeOcrBboxHintPayload };
