// @ts-check
/**
 * @typedef {{ x: number; y: number; w: number; h: number }} ParsedBbox
 * @typedef {{ [key: string]: number | undefined; x1?: number; y1?: number; x2?: number; y2?: number }} PartialParsedBbox
 */

/**
 * @param {PartialParsedBbox | null | undefined} partialBbox
 * @returns {ParsedBbox | null}
 */
function bboxFromPartial(partialBbox) {
  if (!partialBbox) {
    return null;
  }
  const coordinates = [
    Number(partialBbox.x1),
    Number(partialBbox.y1),
    Number(partialBbox.x2),
    Number(partialBbox.y2),
  ];
  if (!coordinates.every(Number.isFinite)) {
    return null;
  }
  const [x1, y1, x2, y2] = coordinates;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    x: left,
    y: top,
    w: Math.max(x1, x2) - left,
    h: Math.max(y1, y2) - top,
  };
}

/** @param {unknown} value @returns {number | null} */
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} [max]
 */
function clampCoordinate(value, min, max = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/** @param {ParsedBbox} bbox */
function clampBbox(bbox) {
  return {
    x: clampCoordinate(bbox.x, 0),
    y: clampCoordinate(bbox.y, 0),
    w: clampCoordinate(bbox.w, 1),
    h: clampCoordinate(bbox.h, 1),
  };
}

/**
 * @param {unknown} item
 * @returns {ParsedBbox | null}
 */
function normalizeBBox(item) {
  const box = asRecord(item);
  if (!box) {
    return null;
  }
  const cornerBbox = bboxFromPartial(readPartialBbox(box));
  return cornerBbox ? roundAndClampBbox(cornerBbox) : null;
}

/** @param {Record<string, unknown>} box @returns {PartialParsedBbox} */
function readPartialBbox(box) {
  return {
    x1: toNumber(box.x1) ?? undefined,
    y1: toNumber(box.y1) ?? undefined,
    x2: toNumber(box.x2) ?? undefined,
    y2: toNumber(box.y2) ?? undefined,
  };
}

/** @param {ParsedBbox} bbox */
function roundAndClampBbox(bbox) {
  return clampBbox({
    x: Math.round(bbox.x),
    y: Math.round(bbox.y),
    w: Math.round(bbox.w),
    h: Math.round(bbox.h),
  });
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

module.exports = {
  asRecord,
  bboxFromPartial,
  normalizeBBox,
  toNumber,
};
