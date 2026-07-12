// @ts-check
/**
 * @typedef {Record<string, unknown>} JsonRecord
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} OcrBox
 */

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
  const rectangle = readFirstBox(record, [
    "bbox",
    "box",
    "rect",
    "rectangle",
    "position",
  ]);
  if (rectangle) {
    return rectangle;
  }
  return readFirstPolygon(record, [
    "polygon",
    "poly",
    "points",
    "polygon_points",
    "rec_poly",
    "det_poly",
  ]);
}

/**
 * @param {JsonRecord} record
 * @param {string[]} keys
 */
function readFirstBox(record, keys) {
  for (const key of keys) {
    const box = boxFromArrayOrObject(record[key]);
    if (box) {
      return box;
    }
  }
  return null;
}

/**
 * @param {JsonRecord} record
 * @param {string[]} keys
 */
function readFirstPolygon(record, keys) {
  for (const key of keys) {
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
  const corners = [
    Number(record.x1 ?? record.left),
    Number(record.y1 ?? record.top),
    Number(record.x2 ?? record.right),
    Number(record.y2 ?? record.bottom),
  ];
  if (corners.every(Number.isFinite)) {
    return { x1: corners[0], y1: corners[1], x2: corners[2], y2: corners[3] };
  }
  const dimensions = [
    Number(record.x),
    Number(record.y),
    Number(record.w ?? record.width),
    Number(record.h ?? record.height),
  ];
  if (!dimensions.every(Number.isFinite)) {
    return null;
  }
  const [x, y, width, height] = dimensions;
  return { x1: x, y1: y, x2: x + width, y2: y + height };
}

/**
 * @param {unknown} value
 * @returns {OcrBox | null}
 */
function boxFromArrayOrObject(value) {
  if (Array.isArray(value)) {
    const box = boxFromFlatArray(value);
    return box || boxFromPolygon(value);
  }
  return value && typeof value === "object"
    ? boxFromNumericFields(value)
    : null;
}

/**
 * @param {unknown[]} value
 * @returns {OcrBox | null}
 */
function boxFromFlatArray(value) {
  if (value.length < 4 || !value.every(isNumericPrimitive)) {
    return null;
  }
  const numbers = value.slice(0, 4).map(Number);
  return numbers.every(Number.isFinite)
    ? { x1: numbers[0], y1: numbers[1], x2: numbers[2], y2: numbers[3] }
    : null;
}

/** @param {unknown} value */
function isNumericPrimitive(value) {
  return typeof value === "number" || typeof value === "string";
}

/**
 * @param {unknown} value
 * @returns {OcrBox | null}
 */
function boxFromPolygon(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const points = value.map(readPolygonPoint).filter(isPoint);
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

/** @param {{ x: number; y: number } | null} point @returns {point is { x: number; y: number }} */
function isPoint(point) {
  return point !== null;
}

/**
 * @param {unknown} point
 * @returns {{ x: number; y: number } | null}
 */
function readPolygonPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    return finitePoint(point[0], point[1]);
  }
  const record = asRecord(point);
  return finitePoint(record.x, record.y);
}

/**
 * @param {unknown} rawX
 * @param {unknown} rawY
 * @returns {{ x: number; y: number } | null}
 */
function finitePoint(rawX, rawY) {
  const x = Number(rawX);
  const y = Number(rawY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
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

module.exports = { asRecord, readRawOcrBox };
