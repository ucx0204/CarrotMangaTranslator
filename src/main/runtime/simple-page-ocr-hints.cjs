const {
  readOcrCandidateText,
  readPositiveInteger,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt
} = require("./simple-page-prompts.cjs");

function extractJsonText(rawText) {
  const text = String(rawText ?? "").trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    return text;
  }

  const firstObject = text.indexOf("{");
  const lastObject = text.lastIndexOf("}");
  const firstArray = text.indexOf("[");
  const lastArray = text.lastIndexOf("]");
  if (firstObject !== -1 && lastObject > firstObject && (firstArray === -1 || firstObject < firstArray)) {
    return text.slice(firstObject, lastObject + 1);
  }
  if (firstArray !== -1 && lastArray > firstArray) {
    return text.slice(firstArray, lastArray + 1);
  }
  return "";
}

function normalizeOcrBboxHintPayload(payload, options = {}) {
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const candidates = collectOcrBboxCandidates(payload);
  const hints = [];

  for (const candidate of candidates) {
    const box = normalizeOcrBboxCandidate(candidate, originalWidth, originalHeight, payload);
    if (!box) {
      continue;
    }
    const label = candidate.label ?? candidate.type ?? candidate.category ?? candidate.class ?? candidate.class_name ?? "text";
    if (isIgnoredOcrLabel(label)) {
      continue;
    }
    const ocrText = sanitizeOcrTextForPrompt(readOcrCandidateText(candidate));
    hints.push({
      id: hints.length + 1,
      label: sanitizeHintLabel(label),
      ...box,
      ...(Number.isFinite(Number(candidate.score ?? candidate.confidence)) ? { score: Number(candidate.score ?? candidate.confidence) } : {}),
      ...(ocrText ? { ocrText } : {})
    });
  }

  return attachOcrGroupingHints(hints, {
    imageWidth: originalWidth,
    imageHeight: originalHeight
  }).slice(0, 80);
}

function collectOcrBboxCandidates(payload) {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.blocks)) return payload.blocks;
  if (Array.isArray(payload.parsing_res_list)) return payload.parsing_res_list;
  if (Array.isArray(payload.layout_det_res?.boxes)) return payload.layout_det_res.boxes;
  if (Array.isArray(payload.pages)) return payload.pages.flatMap(collectOcrBboxCandidates);
  if (Array.isArray(payload.results)) return payload.results.flatMap(collectOcrBboxCandidates);
  if (payload.result && typeof payload.result === "object") return collectOcrBboxCandidates(payload.result);
  if (payload.data && typeof payload.data === "object") return collectOcrBboxCandidates(payload.data);
  return [];
}

function normalizeOcrBboxCandidate(candidate, originalWidth, originalHeight, payload) {
  const rawBox = readRawOcrBox(candidate);
  if (!rawBox) {
    return null;
  }

  const payloadSpace = String(payload?.coordinateSpace ?? payload?.bboxCoordinateSpace ?? candidate.coordinateSpace ?? "").toLowerCase();
  const sourceWidth = readPositiveInteger(payload?.width ?? payload?.imageWidth ?? candidate.imageWidth) || originalWidth;
  const sourceHeight = readPositiveInteger(payload?.height ?? payload?.imageHeight ?? candidate.imageHeight) || originalHeight;
  let { x1, y1, x2, y2 } = rawBox;

  if (payloadSpace.includes("1000") && originalWidth && originalHeight) {
    x1 = (x1 / 1000) * originalWidth;
    x2 = (x2 / 1000) * originalWidth;
    y1 = (y1 / 1000) * originalHeight;
    y2 = (y2 / 1000) * originalHeight;
  } else if (sourceWidth && sourceHeight && originalWidth && originalHeight && (sourceWidth !== originalWidth || sourceHeight !== originalHeight)) {
    x1 = (x1 / sourceWidth) * originalWidth;
    x2 = (x2 / sourceWidth) * originalWidth;
    y1 = (y1 / sourceHeight) * originalHeight;
    y2 = (y2 / sourceHeight) * originalHeight;
  }

  const left = Math.max(0, Math.round(Math.min(x1, x2)));
  const top = Math.max(0, Math.round(Math.min(y1, y2)));
  const right = originalWidth ? Math.min(originalWidth, Math.round(Math.max(x1, x2))) : Math.round(Math.max(x1, x2));
  const bottom = originalHeight ? Math.min(originalHeight, Math.round(Math.max(y1, y2))) : Math.round(Math.max(y1, y2));
  if (right - left < 2 || bottom - top < 2) {
    return null;
  }
  return { x1: left, y1: top, x2: right, y2: bottom };
}

function readRawOcrBox(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const direct = boxFromNumericFields(candidate);
  if (direct) {
    return direct;
  }

  for (const key of ["bbox", "box", "rect", "rectangle", "position"]) {
    const box = boxFromArrayOrObject(candidate[key]);
    if (box) {
      return box;
    }
  }

  for (const key of ["polygon", "poly", "points", "polygon_points", "rec_poly", "det_poly"]) {
    const box = boxFromPolygon(candidate[key]);
    if (box) {
      return box;
    }
  }

  return null;
}

function boxFromNumericFields(value) {
  const x1 = Number(value.x1 ?? value.left);
  const y1 = Number(value.y1 ?? value.top);
  const x2 = Number(value.x2 ?? value.right);
  const y2 = Number(value.y2 ?? value.bottom);
  if ([x1, y1, x2, y2].every(Number.isFinite)) {
    return { x1, y1, x2, y2 };
  }

  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w ?? value.width);
  const h = Number(value.h ?? value.height);
  if ([x, y, w, h].every(Number.isFinite)) {
    return { x1: x, y1: y, x2: x + w, y2: y + h };
  }

  return null;
}

function boxFromArrayOrObject(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length >= 4 && value.every((item) => typeof item === "number" || typeof item === "string")) {
      const numbers = value.slice(0, 4).map(Number);
      if (numbers.every(Number.isFinite)) {
        return { x1: numbers[0], y1: numbers[1], x2: numbers[2], y2: numbers[3] };
      }
    }
    return boxFromPolygon(value);
  }
  if (typeof value === "object") {
    return boxFromNumericFields(value);
  }
  return null;
}

function boxFromPolygon(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const points = [];
  for (const point of value) {
    if (Array.isArray(point) && point.length >= 2) {
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x, y });
      }
    } else if (point && typeof point === "object") {
      const x = Number(point.x);
      const y = Number(point.y);
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
    y2: Math.max(...points.map((point) => point.y))
  };
}

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
    "header"
  ].includes(normalized);
}

function attachOcrGroupingHints(hints, options = {}) {
  if (!Array.isArray(hints) || hints.length < 2) {
    return Array.isArray(hints) ? hints : [];
  }

  const items = hints.map((hint, index) => ({
    hint,
    index,
    eligible: isSemanticGroupingCandidate(hint)
  }));
  const parent = items.map((_, index) => index);

  function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

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
      if (items[right].eligible && areGroupingCompatible(items[left].hint, items[right].hint, options)) {
        union(left, right);
      }
    }
  }

  const groups = new Map();
  for (const item of items) {
    if (!item.eligible) continue;
    const root = find(item.index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  }

  let groupNumber = 1;
  for (const group of groups.values()) {
    if (group.length < 2 || group.length > 4) {
      continue;
    }
    group.sort((left, right) => compareJapaneseReadingOrder(left.hint, right.hint));
    const groupId = `G${String(groupNumber).padStart(3, "0")}`;
    groupNumber += 1;
    group.forEach((item, orderIndex) => {
      item.hint.groupId = groupId;
      item.hint.orderInGroup = orderIndex + 1;
      item.hint.rolePrior = "ordinary_soft";
      item.hint.containerType = "possible_continuing_text";
    });
  }

  return hints;
}

function isSemanticGroupingCandidate(hint) {
  const label = sanitizeHintLabel(hint?.label);
  const text = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  if (!text || !hasJapaneseTextEvidence(text) || !hasHiragana(text) || hasCjkIdeograph(text)) {
    return false;
  }

  const baseLength = text.replace(/[^\u3040-\u309f\u30a0-\u30ff]/g, "").length;
  if (baseLength < 2 || baseLength > 10) {
    return false;
  }

  return label.includes("vertical") || isTallBox(hint);
}

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
  if (leftHeight <= 0 || rightHeight <= 0 || leftWidth <= 0 || rightWidth <= 0) {
    return false;
  }

  const yOverlap = Math.max(0, Math.min(leftBox.y2, rightBox.y2) - Math.max(leftBox.y1, rightBox.y1));
  const overlapRatio = yOverlap / Math.min(leftHeight, rightHeight);
  const centerYDistance = Math.abs(centerOf(leftBox).y - centerOf(rightBox).y);
  const sameReadingBand = overlapRatio >= 0.25 || centerYDistance <= Math.max(leftHeight, rightHeight) * 0.75;
  if (!sameReadingBand) {
    return false;
  }

  const pageWidth = readPositiveInteger(options.imageWidth) || Math.max(leftBox.x2, rightBox.x2);
  const centerXDistance = Math.abs(centerOf(leftBox).x - centerOf(rightBox).x);
  if (pageWidth && centerXDistance > pageWidth * 0.85) {
    return false;
  }

  const areaRatio = (leftWidth * leftHeight) / Math.max(1, rightWidth * rightHeight);
  return areaRatio >= 0.15 && areaRatio <= 6.5;
}

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

function readHintBox(hint) {
  const x1 = Number(hint?.x1);
  const y1 = Number(hint?.y1);
  const x2 = Number(hint?.x2);
  const y2 = Number(hint?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    return null;
  }
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2)
  };
}

function centerOf(box) {
  return {
    x: (box.x1 + box.x2) / 2,
    y: (box.y1 + box.y2) / 2
  };
}

function isTallBox(hint) {
  const box = readHintBox(hint);
  return Boolean(box && box.y2 - box.y1 > (box.x2 - box.x1) * 1.2);
}

function hasJapaneseTextEvidence(text) {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]/u.test(String(text ?? ""));
}

function hasHiragana(text) {
  return /[\u3040-\u309f]/u.test(String(text ?? ""));
}

function hasCjkIdeograph(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text ?? ""));
}

module.exports = {
  attachOcrGroupingHints,
  extractJsonText,
  normalizeOcrBboxHintPayload
};
