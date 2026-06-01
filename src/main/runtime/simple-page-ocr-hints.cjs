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

  return hints.slice(0, 80);
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

module.exports = {
  extractJsonText,
  normalizeOcrBboxHintPayload
};
