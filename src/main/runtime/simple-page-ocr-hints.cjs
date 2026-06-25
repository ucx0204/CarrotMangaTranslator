// @ts-check
/**
 * @typedef {Record<string, unknown>} JsonRecord
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} OcrBox
 * @typedef {OcrBox & { id?: number; label?: string; ocrText?: string; score?: number; groupId?: string; orderInGroup?: number; rolePrior?: string; containerType?: string; [key: string]: unknown }} OcrHint
 * @typedef {{ imageWidth?: unknown; imageHeight?: unknown; [key: string]: unknown }} OcrHintOptions
 * @typedef {{ hint: OcrHint; index: number; eligible: boolean }} GroupItem
 */
const {
  readOcrCandidateText,
  readPositiveInteger,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
} = require("./simple-page-prompts.cjs");

/** @param {unknown} rawText */
function extractJsonText(rawText) {
  const text = String(rawText ?? "").trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    return text;
  }

  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (
    firstObject !== -1 &&
    lastObject > firstObject &&
    (firstArray === -1 || firstObject < firstArray)
  ) {
    return text.slice(firstObject, lastObject + 1);
  }
  if (firstArray !== -1 && lastArray > firstArray) {
    return text.slice(firstArray, lastArray + 1);
  }
  return "";
}

/**
 * @param {unknown} payload
 * @param {OcrHintOptions} [options]
 * @returns {OcrHint[]}
 */
function normalizeOcrBboxHintPayload(payload, options = {}) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const candidates = collectOcrBboxCandidates(payload);
  /** @type {OcrHint[]} */
  const hints = [];

  for (const candidate of candidates) {
    const candidateRecord = asRecord(candidate);
    const box = normalizeOcrBboxCandidate(
      candidate,
      originalWidth,
      originalHeight,
      payload,
    );
    if (!box) {
      continue;
    }
    const label =
      candidateRecord.label ??
      candidateRecord.type ??
      candidateRecord.category ??
      candidateRecord.class ??
      candidateRecord.class_name ??
      "text";
    if (isIgnoredOcrLabel(label)) {
      continue;
    }
    const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(candidate));
    hints.push({
      id: hints.length + 1,
      label: sanitizeHintLabel(label),
      ...box,
      ...(Number.isFinite(
        Number(candidateRecord.score ?? candidateRecord.confidence),
      )
        ? { score: Number(candidateRecord.score ?? candidateRecord.confidence) }
        : {}),
      ...(ocrText ? { ocrText } : {}),
    });
  }

  return attachOcrGroupingHints(hints, {
    imageWidth: originalWidth,
    imageHeight: originalHeight,
  }).slice(0, 80);
}

/**
 * @param {unknown} payload
 * @returns {unknown[]}
 */
function collectOcrBboxCandidates(payload) {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  const layout = asRecord(record.layout_det_res);
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.blocks)) return record.blocks;
  if (Array.isArray(record.parsing_res_list)) return record.parsing_res_list;
  if (Array.isArray(layout.boxes)) return layout.boxes;
  if (Array.isArray(record.pages))
    return record.pages.flatMap(collectOcrBboxCandidates);
  if (Array.isArray(record.results))
    return record.results.flatMap(collectOcrBboxCandidates);
  if (record.result && typeof record.result === "object")
    return collectOcrBboxCandidates(record.result);
  if (record.data && typeof record.data === "object")
    return collectOcrBboxCandidates(record.data);
  return [];
}

function normalizeOcrBboxCandidate(
  /** @type {unknown} */
  candidate,
  /** @type {number | null | undefined} */
  originalWidth,
  /** @type {number | null | undefined} */
  originalHeight,
  /** @type {unknown} */
  payload,
) {
  const candidateRecord = asRecord(candidate);
  const payloadRecord = asRecord(payload);
  const rawBox = readRawOcrBox(candidate);
  if (!rawBox) {
    return null;
  }

  const payloadSpace = String(
    payloadRecord.coordinateSpace ??
      payloadRecord.bboxCoordinateSpace ??
      candidateRecord.coordinateSpace ??
      "",
  ).toLowerCase();
  const sourceWidth =
    readPositiveInteger(
      payloadRecord.width ??
        payloadRecord.imageWidth ??
        candidateRecord.imageWidth,
    ) || originalWidth;
  const sourceHeight =
    readPositiveInteger(
      payloadRecord.height ??
        payloadRecord.imageHeight ??
        candidateRecord.imageHeight,
    ) || originalHeight;
  let { x1, y1, x2, y2 } = rawBox;

  if (payloadSpace.includes("1000") && originalWidth && originalHeight) {
    x1 = (x1 / 1000) * originalWidth;
    x2 = (x2 / 1000) * originalWidth;
    y1 = (y1 / 1000) * originalHeight;
    y2 = (y2 / 1000) * originalHeight;
  } else if (
    sourceWidth &&
    sourceHeight &&
    originalWidth &&
    originalHeight &&
    (sourceWidth !== originalWidth || sourceHeight !== originalHeight)
  ) {
    x1 = (x1 / sourceWidth) * originalWidth;
    x2 = (x2 / sourceWidth) * originalWidth;
    y1 = (y1 / sourceHeight) * originalHeight;
    y2 = (y2 / sourceHeight) * originalHeight;
  }

  const left = Math.max(0, Math.round(Math.min(x1, x2)));
  const top = Math.max(0, Math.round(Math.min(y1, y2)));
  const right = originalWidth
    ? Math.min(originalWidth, Math.round(Math.max(x1, x2)))
    : Math.round(Math.max(x1, x2));
  const bottom = originalHeight
    ? Math.min(originalHeight, Math.round(Math.max(y1, y2)))
    : Math.round(Math.max(y1, y2));
  if (right - left < 2 || bottom - top < 2) {
    return null;
  }
  return { x1: left, y1: top, x2: right, y2: bottom };
}

/** @param {unknown} candidate */
function readRawOcrBox(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = asRecord(candidate);
  const direct = boxFromNumericFields(candidate);
  if (direct) {
    return direct;
  }

  for (const key of ["bbox", "box", "rect", "rectangle", "position"]) {
    const box = boxFromArrayOrObject(record[key]);
    if (box) {
      return box;
    }
  }

  for (const key of [
    "polygon",
    "poly",
    "points",
    "polygon_points",
    "rec_poly",
    "det_poly",
  ]) {
    const box = boxFromPolygon(record[key]);
    if (box) {
      return box;
    }
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {OcrBox | null}
 */
function boxFromNumericFields(value) {
  const record = asRecord(value);
  const x1 = Number(record.x1 ?? record.left);
  const y1 = Number(record.y1 ?? record.top);
  const x2 = Number(record.x2 ?? record.right);
  const y2 = Number(record.y2 ?? record.bottom);
  if ([x1, y1, x2, y2].every(Number.isFinite)) {
    return { x1, y1, x2, y2 };
  }

  const x = Number(record.x);
  const y = Number(record.y);
  const w = Number(record.w ?? record.width);
  const h = Number(record.h ?? record.height);
  if ([x, y, w, h].every(Number.isFinite)) {
    return { x1: x, y1: y, x2: x + w, y2: y + h };
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {OcrBox | null}
 */
function boxFromArrayOrObject(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    if (
      value.length >= 4 &&
      value.every(
        (item) => typeof item === "number" || typeof item === "string",
      )
    ) {
      const numbers = value.slice(0, 4).map(Number);
      if (numbers.every(Number.isFinite)) {
        return {
          x1: numbers[0],
          y1: numbers[1],
          x2: numbers[2],
          y2: numbers[3],
        };
      }
    }
    return boxFromPolygon(value);
  }
  if (typeof value === "object") {
    return boxFromNumericFields(value);
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {OcrBox | null}
 */
function boxFromPolygon(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  /** @type {Array<{ x: number; y: number }>} */
  const points = [];
  for (const point of value) {
    if (Array.isArray(point) && point.length >= 2) {
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y });
      }
    } else if (point && typeof point === "object") {
      const record = asRecord(point);
      const x = Number(record.x);
      const y = Number(record.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y });
      }
    }
  }
  if (points.length === 0) {
    return null;
  }
  return {
    x1: Math.min(...points.map((point) => point.x)),
    y1: Math.min(...points.map((point) => point.y)),
    x2: Math.max(...points.map((point) => point.x)),
    y2: Math.max(...points.map((point) => point.y)),
  };
}

/** @param {unknown} label */
function isIgnoredOcrLabel(label) {
  const normalized = sanitizeHintLabel(label);
  return [
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
  ].includes(normalized);
}

/**
 * @param {OcrHint[]} hints
 * @param {OcrHintOptions} [options]
 * @returns {OcrHint[]}
 */
function attachOcrGroupingHints(hints, options = {}) {
  if (!Array.isArray(hints) || hints.length < 2) {
    return Array.isArray(hints) ? hints : [];
  }

  const nextGroupNumber = attachAdjacentTextContainerGroups(hints, options, 1);
  attachSoftSemanticGroups(hints, options, nextGroupNumber);
  return hints;
}

/**
 * @param {OcrHint[]} hints
 * @param {OcrHintOptions} [options]
 * @param {number} [startGroupNumber]
 * @returns {number}
 */
function attachAdjacentTextContainerGroups(
  hints,
  options = {},
  startGroupNumber = 1,
) {
  const items = hints.map((hint, index) => ({
    hint,
    index,
    eligible: isAdjacentTextContainerCandidate(hint),
  }));
  const groups = collectCompatibleHintGroups(items, (left, right) =>
    areAdjacentTextContainerCompatible(left, right, options),
  );

  let groupNumber = startGroupNumber;
  for (const group of groups.values()) {
    if (group.length < 2 || group.length > 4) {
      continue;
    }
    group.sort((left, right) =>
      compareJapaneseReadingOrder(left.hint, right.hint),
    );
    const groupId = `G${String(groupNumber).padStart(3, "0")}`;
    groupNumber += 1;
    group.forEach((item, orderIndex) => {
      item.hint.groupId = groupId;
      item.hint.orderInGroup = orderIndex + 1;
      item.hint.rolePrior = "ordinary_mergeable";
      item.hint.containerType = "same_text_container";
    });
  }
  return groupNumber;
}

/**
 * @param {OcrHint[]} hints
 * @param {OcrHintOptions} [options]
 * @param {number} [startGroupNumber]
 * @returns {number}
 */
function attachSoftSemanticGroups(hints, options = {}, startGroupNumber = 1) {
  const items = hints.map((hint, index) => ({
    hint,
    index,
    eligible: !hint.groupId && isSemanticGroupingCandidate(hint),
  }));
  const groups = collectCompatibleHintGroups(items, (left, right) =>
    areGroupingCompatible(left, right, options),
  );

  let groupNumber = startGroupNumber;
  for (const group of groups.values()) {
    if (group.length < 2 || group.length > 4) {
      continue;
    }
    group.sort((left, right) =>
      compareJapaneseReadingOrder(left.hint, right.hint),
    );
    const groupId = `G${String(groupNumber).padStart(3, "0")}`;
    groupNumber += 1;
    group.forEach((item, orderIndex) => {
      item.hint.groupId = groupId;
      item.hint.orderInGroup = orderIndex + 1;
      item.hint.rolePrior = "ordinary_soft";
      item.hint.containerType = "possible_continuing_text";
    });
  }
  return groupNumber;
}

/**
 * @param {GroupItem[]} items
 * @param {(left: OcrHint, right: OcrHint) => boolean} isCompatible
 * @returns {Map<number, GroupItem[]>}
 */
function collectCompatibleHintGroups(items, isCompatible) {
  /** @type {number[]} */
  const parent = items.map((_, index) => index);

  /** @param {number} index */
  function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

  /**
   * @param {number} left
   * @param {number} right
   */
  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  }

  for (let left = 0; left < items.length; left += 1) {
    if (!items[left].eligible) continue;
    for (let right = left + 1; right < items.length; right += 1) {
      if (
        items[right].eligible &&
        isCompatible(items[left].hint, items[right].hint)
      ) {
        union(left, right);
      }
    }
  }

  /** @type {Map<number, GroupItem[]>} */
  const groups = new Map();
  for (const item of items) {
    if (!item.eligible) continue;
    const root = find(item.index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  }

  return groups;
}

/** @param {OcrHint} hint */
function isAdjacentTextContainerCandidate(hint) {
  const label = sanitizeHintLabel(hint?.label);
  const text = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  if (!text || !hasJapaneseTextEvidence(text) || !isTallBox(hint)) {
    return false;
  }
  if (!label.includes("textline") && !label.includes("vertical")) {
    return false;
  }

  const japaneseLength = [...text.replace(/\s+/g, "")].filter((char) =>
    hasJapaneseTextEvidence(char),
  ).length;
  return japaneseLength >= 2 && japaneseLength <= 40;
}

/**
 * @param {OcrHint} left
 * @param {OcrHint} right
 * @param {OcrHintOptions} [options]
 */
function areAdjacentTextContainerCompatible(left, right, options = {}) {
  const leftBox = readHintBox(left);
  const rightBox = readHintBox(right);
  if (!leftBox || !rightBox) {
    return false;
  }

  const leftHeight = leftBox.y2 - leftBox.y1;
  const rightHeight = rightBox.y2 - rightBox.y1;
  const leftWidth = leftBox.x2 - leftBox.x1;
  const rightWidth = rightBox.x2 - rightBox.x1;
  if (
    leftHeight <= 0 ||
    rightHeight <= 0 ||
    leftWidth <= 0 ||
    rightWidth <= 0
  ) {
    return false;
  }

  const heightRatio =
    Math.min(leftHeight, rightHeight) / Math.max(leftHeight, rightHeight);
  if (heightRatio < 0.55) {
    return false;
  }

  const yOverlap = Math.max(
    0,
    Math.min(leftBox.y2, rightBox.y2) - Math.max(leftBox.y1, rightBox.y1),
  );
  const yOverlapRatio = yOverlap / Math.min(leftHeight, rightHeight);
  if (yOverlapRatio < 0.62) {
    return false;
  }

  const xGap = Math.max(
    0,
    Math.max(leftBox.x1, rightBox.x1) - Math.min(leftBox.x2, rightBox.x2),
  );
  if (xGap > Math.max(12, Math.min(leftWidth, rightWidth) * 0.45)) {
    return false;
  }

  const pageWidth =
    readPositiveInteger(options.imageWidth) ||
    Math.max(leftBox.x2, rightBox.x2);
  const centerXDistance = Math.abs(centerOf(leftBox).x - centerOf(rightBox).x);
  return !pageWidth || centerXDistance <= pageWidth * 0.25;
}

/** @param {OcrHint} hint */
function isSemanticGroupingCandidate(hint) {
  const label = sanitizeHintLabel(hint?.label);
  const text = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  if (
    !text ||
    !hasJapaneseTextEvidence(text) ||
    !hasHiragana(text) ||
    hasCjkIdeograph(text)
  ) {
    return false;
  }

  const baseLength = text.replace(/[^\u3040-\u309f\u30a0-\u30ff]/g, "").length;
  if (baseLength < 2 || baseLength > 10) {
    return false;
  }

  return label.includes("vertical") || isTallBox(hint);
}

/**
 * @param {OcrHint} left
 * @param {OcrHint} right
 * @param {OcrHintOptions} [options]
 */
function areGroupingCompatible(left, right, options = {}) {
  const leftBox = readHintBox(left);
  const rightBox = readHintBox(right);
  if (!leftBox || !rightBox) {
    return false;
  }

  const leftHeight = leftBox.y2 - leftBox.y1;
  const rightHeight = rightBox.y2 - rightBox.y1;
  const leftWidth = leftBox.x2 - leftBox.x1;
  const rightWidth = rightBox.x2 - rightBox.x1;
  if (
    leftHeight <= 0 ||
    rightHeight <= 0 ||
    leftWidth <= 0 ||
    rightWidth <= 0
  ) {
    return false;
  }

  const yOverlap = Math.max(
    0,
    Math.min(leftBox.y2, rightBox.y2) - Math.max(leftBox.y1, rightBox.y1),
  );
  const overlapRatio = yOverlap / Math.min(leftHeight, rightHeight);
  const centerYDistance = Math.abs(centerOf(leftBox).y - centerOf(rightBox).y);
  const sameReadingBand =
    overlapRatio >= 0.25 ||
    centerYDistance <= Math.max(leftHeight, rightHeight) * 0.75;
  if (!sameReadingBand) {
    return false;
  }

  const pageWidth =
    readPositiveInteger(options.imageWidth) ||
    Math.max(leftBox.x2, rightBox.x2);
  const centerXDistance = Math.abs(centerOf(leftBox).x - centerOf(rightBox).x);
  if (pageWidth && centerXDistance > pageWidth * 0.85) {
    return false;
  }

  const areaRatio =
    (leftWidth * leftHeight) / Math.max(1, rightWidth * rightHeight);
  return areaRatio >= 0.15 && areaRatio <= 6.5;
}

/**
 * @param {OcrHint} left
 * @param {OcrHint} right
 */
function compareJapaneseReadingOrder(left, right) {
  const leftBox = readHintBox(left);
  const rightBox = readHintBox(right);
  if (!leftBox || !rightBox) return 0;
  const leftCenter = centerOf(leftBox);
  const rightCenter = centerOf(rightBox);
  const xDistance = rightCenter.x - leftCenter.x;
  if (Math.abs(xDistance) > 12) {
    return xDistance;
  }
  return leftCenter.y - rightCenter.y;
}

/** @param {unknown} hint */
function readHintBox(hint) {
  const record = asRecord(hint);
  const x1 = Number(record.x1);
  const y1 = Number(record.y1);
  const x2 = Number(record.x2);
  const y2 = Number(record.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return null;
  }
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  };
}

/** @param {OcrBox} box */
function centerOf(box) {
  return {
    x: (box.x1 + box.x2) / 2,
    y: (box.y1 + box.y2) / 2,
  };
}

/** @param {OcrHint} hint */
function isTallBox(hint) {
  const box = readHintBox(hint);
  return Boolean(box && box.y2 - box.y1 > (box.x2 - box.x1) * 1.2);
}

/** @param {unknown} text */
function hasJapaneseTextEvidence(text) {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]/u.test(
    String(text ?? ""),
  );
}

/** @param {unknown} text */
function hasHiragana(text) {
  return /[\u3040-\u309f]/u.test(String(text ?? ""));
}

/** @param {unknown} text */
function hasCjkIdeograph(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text ?? ""));
}

/**
 * @param {unknown} value
 * @returns {JsonRecord}
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {JsonRecord} */ (value)
    : {};
}

module.exports = {
  attachOcrGroupingHints,
  extractJsonText,
  normalizeOcrBboxHintPayload,
};
