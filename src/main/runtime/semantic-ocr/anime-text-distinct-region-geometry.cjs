// @ts-check

const MIN_READING_START_SCALE = 1.5;
const MIN_CROSS_GAP_SCALE = 0.25;
const MIN_READING_GAP_SCALE = 0.25;

/**
 * @typedef {Record<string,unknown>} Candidate
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} Box
 * @typedef {{candidates:Candidate[];bbox:Box}} Fragment
 * @typedef {{
 *   writingMode:"vertical"|"horizontal";
 *   characterScale:number;
 *   startDeltaPx:number;
 *   crossGapPx:number;
 *   readingGapPx:number;
 * }} PairGeometry
 */

/**
 * Nearby columns inside one balloon commonly share a reading start. Require
 * both fragments to have the same clear writing direction, a substantially
 * offset reading start, and a real gap on either axis. The reading-axis
 * alternative covers diagonally separated text lobes whose x/y spans overlap
 * on the cross axis without weakening the large-start-offset requirement.
 *
 * @param {Fragment} left
 * @param {Fragment} right
 * @param {{requireCrossAxisGap?:boolean}} [options]
 * @returns {PairGeometry|null}
 */
function readDistinctPairGeometry(left, right, options = {}) {
  const leftMode = readWritingMode(left);
  const rightMode = readWritingMode(right);
  if (!leftMode || leftMode !== rightMode) return null;
  const boxes = [...left.candidates, ...right.candidates].map(readCandidateBox);
  if (boxes.some((box) => box === null)) return null;
  const characterScale = median(
    /** @type {Box[]} */ (boxes)
      .map((box) => Math.min(box.x2 - box.x1, box.y2 - box.y1))
      .sort((leftValue, rightValue) => leftValue - rightValue),
  );
  const vertical = leftMode === "vertical";
  const startDeltaPx = readingStartDelta(left.bbox, right.bbox, vertical);
  const crossGapPx = crossAxisGap(left.bbox, right.bbox, vertical);
  const readingGapPx = readingAxisGap(left.bbox, right.bbox, vertical);
  const hasCrossAxisGap = crossGapPx >= characterScale * MIN_CROSS_GAP_SCALE;
  const hasReadingAxisGap =
    readingGapPx >= characterScale * MIN_READING_GAP_SCALE;
  if (
    startDeltaPx < characterScale * MIN_READING_START_SCALE ||
    (!hasCrossAxisGap &&
      (options.requireCrossAxisGap === true || !hasReadingAxisGap))
  ) {
    return null;
  }
  return {
    writingMode: leftMode,
    characterScale: roundCoordinate(characterScale),
    startDeltaPx: roundCoordinate(startDeltaPx),
    crossGapPx: roundCoordinate(crossGapPx),
    readingGapPx: roundCoordinate(readingGapPx),
  };
}

/** @param {Fragment} fragment */
function readWritingMode(fragment) {
  const modes = fragment.candidates.map((candidate) => {
    const box = readCandidateBox(candidate);
    if (!box) return null;
    if (box.y2 - box.y1 >= (box.x2 - box.x1) * 1.2) return "vertical";
    if (box.x2 - box.x1 >= (box.y2 - box.y1) * 1.2) return "horizontal";
    return null;
  });
  if (modes.every((mode) => mode === "vertical")) return "vertical";
  if (modes.every((mode) => mode === "horizontal")) return "horizontal";
  return null;
}

/** @param {Candidate} candidate @returns {Box|null} */
function readCandidateBox(candidate) {
  let source = candidate;
  if (isRecord(candidate.bbox)) {
    source = candidate.bbox;
  }
  const box = {
    x1: Number(source.x1),
    y1: Number(source.y1),
    x2: Number(source.x2),
    y2: Number(source.y2),
  };
  if (!Object.values(box).every(Number.isFinite)) return null;
  if (box.x2 <= box.x1 || box.y2 <= box.y1) return null;
  return box;
}

/** @param {number[]} left @param {number[]} right */
function smallerBoxOverlapRatio(left, right) {
  const leftBox = tupleToBox(left);
  const rightBox = tupleToBox(right);
  const intersection =
    Math.max(
      0,
      Math.min(leftBox.x2, rightBox.x2) - Math.max(leftBox.x1, rightBox.x1),
    ) *
    Math.max(
      0,
      Math.min(leftBox.y2, rightBox.y2) - Math.max(leftBox.y1, rightBox.y1),
    );
  return intersection / Math.min(boxArea(leftBox), boxArea(rightBox));
}

/** @param {number[]} tuple @returns {Box} */
function tupleToBox(tuple) {
  return { x1: tuple[0], y1: tuple[1], x2: tuple[2], y2: tuple[3] };
}

/** @param {Box} box */
function boxArea(box) {
  return Math.max(1, box.x2 - box.x1) * Math.max(1, box.y2 - box.y1);
}

/** @param {Box} left @param {Box} right @param {boolean} vertical */
function readingStartDelta(left, right, vertical) {
  return vertical ? Math.abs(left.y1 - right.y1) : Math.abs(left.x1 - right.x1);
}

/** @param {Box} left @param {Box} right @param {boolean} vertical */
function crossAxisGap(left, right, vertical) {
  const start = vertical ? "x1" : "y1";
  const end = vertical ? "x2" : "y2";
  return Math.max(
    0,
    Math.max(left[start], right[start]) - Math.min(left[end], right[end]),
  );
}

/** @param {Box} left @param {Box} right @param {boolean} vertical */
function readingAxisGap(left, right, vertical) {
  const start = vertical ? "y1" : "x1";
  const end = vertical ? "y2" : "x2";
  return Math.max(
    0,
    Math.max(left[start], right[start]) - Math.min(left[end], right[end]),
  );
}

/** @param {Box} left @param {Box} right */
function unionBoxes(left, right) {
  return {
    x1: Math.min(left.x1, right.x1),
    y1: Math.min(left.y1, right.y1),
    x2: Math.max(left.x2, right.x2),
    y2: Math.max(left.y2, right.y2),
  };
}

/** @param {number[]} sorted */
function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** @param {number} value */
function roundCoordinate(value) {
  return Math.round(value * 10) / 10;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string,unknown>}
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  readCandidateBox,
  readDistinctPairGeometry,
  smallerBoxOverlapRatio,
  unionBoxes,
};
