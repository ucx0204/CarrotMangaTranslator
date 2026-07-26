// @ts-check

const {
  readCandidateBox: readBox,
  unionBoxes,
} = require("./anime-text-distinct-region-geometry.cjs");

const MIN_BAND_CANDIDATES = 3;
const MIN_PRIMARY_GAP_SCALE = 2.5;
const MAX_SECONDARY_GAP_SCALE = 0.8;

/**
 * @typedef {Record<string,unknown>} Candidate
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} Box
 * @typedef {{
 *   fragmentId:string;
 *   status:"confirmed"|"deferred";
 *   candidates:Candidate[];
 *   bbox:Box;
 *   sourceFragmentId?:string;
 *   syntheticFragmentId?:string;
 *   paddleGroupId?:string;
 *   partitionKey?:string;
 * }} Fragment
 * @typedef {{candidate:Candidate;start:number}} OrderedCandidate
 * @typedef {{splitIndex:number;gap:number}} ReadingStartGap
 */

/**
 * Require one complete Paddle group and a unique scale-relative reading-start
 * gap dividing it into two bands of at least three candidates each.
 *
 * @param {Fragment} source
 * @returns {{paddleGroupId:string;fragments:[Fragment,Fragment]}|null}
 */
function buildCompleteReadingStartBandPartition(source) {
  const analysis = readCompleteBandSource(source);
  if (!analysis) return null;

  const ordered = orderCandidatesByReadingStart(
    source.candidates,
    analysis.boxes,
    analysis.writingMode,
  );
  const split = readUniqueReadingStartSplit(ordered, analysis.characterScale);
  if (!split) return null;

  const bands = partitionCandidates(source.candidates, ordered, split);
  const fragments = bands.map((candidates, index) =>
    buildSyntheticReadingBandFragment(
      source,
      analysis.paddleGroupId,
      candidates,
      index + 1,
    ),
  );
  if (fragments.some((fragment) => fragment === null)) return null;
  return {
    paddleGroupId: analysis.paddleGroupId,
    fragments: /** @type {[Fragment,Fragment]} */ (fragments),
  };
}

/**
 * @param {Fragment} source
 * @returns {{
 *   paddleGroupId:string;
 *   boxes:Box[];
 *   writingMode:"vertical"|"horizontal";
 *   characterScale:number;
 * }|null}
 */
function readCompleteBandSource(source) {
  if (source.candidates.length < MIN_BAND_CANDIDATES * 2) return null;
  const paddleGroupId = readUniformPaddleGroupId(source.candidates);
  if (!paddleGroupId) return null;
  if (!hasCompletePaddleSidecar(source.candidates)) return null;

  const boxes = source.candidates.map(readBox);
  if (boxes.some((box) => box === null)) return null;
  const completeBoxes = /** @type {Box[]} */ (boxes);
  const writingMode = readUniformWritingMode(completeBoxes);
  if (!writingMode) return null;
  return {
    paddleGroupId,
    boxes: completeBoxes,
    writingMode,
    characterScale: readCharacterScale(completeBoxes),
  };
}

/**
 * @param {Candidate[]} candidates
 * @param {Box[]} boxes
 * @param {"vertical"|"horizontal"} writingMode
 * @returns {OrderedCandidate[]}
 */
function orderCandidatesByReadingStart(candidates, boxes, writingMode) {
  const startKey = writingMode === "vertical" ? "y1" : "x1";
  return candidates
    .map((candidate, index) => ({
      candidate,
      start: boxes[index][startKey],
    }))
    .sort(
      (left, right) =>
        left.start - right.start ||
        Number(left.candidate.id) - Number(right.candidate.id),
    );
}

/**
 * @param {OrderedCandidate[]} ordered
 * @param {number} characterScale
 * @returns {number|null}
 */
function readUniqueReadingStartSplit(ordered, characterScale) {
  const gaps = collectReadingStartGaps(ordered);
  const largest = gaps[0];
  if (!largest) return null;
  if (!hasEnoughCandidatesOnBothSides(ordered.length, largest.splitIndex)) {
    return null;
  }
  const secondLargestGap = gaps[1]?.gap ?? 0;
  if (!isGapDistinctEnough(largest.gap, secondLargestGap, characterScale)) {
    return null;
  }
  return largest.splitIndex;
}

/** @param {OrderedCandidate[]} ordered @returns {ReadingStartGap[]} */
function collectReadingStartGaps(ordered) {
  return ordered
    .slice(1)
    .map((item, index) => ({
      splitIndex: index + 1,
      gap: item.start - ordered[index].start,
    }))
    .sort(
      (left, right) =>
        right.gap - left.gap || left.splitIndex - right.splitIndex,
    );
}

/** @param {number} candidateCount @param {number} splitIndex */
function hasEnoughCandidatesOnBothSides(candidateCount, splitIndex) {
  return (
    splitIndex >= MIN_BAND_CANDIDATES &&
    candidateCount - splitIndex >= MIN_BAND_CANDIDATES
  );
}

/**
 * @param {number} largestGap
 * @param {number} secondLargestGap
 * @param {number} characterScale
 */
function isGapDistinctEnough(largestGap, secondLargestGap, characterScale) {
  return (
    largestGap >= characterScale * MIN_PRIMARY_GAP_SCALE &&
    secondLargestGap <= characterScale * MAX_SECONDARY_GAP_SCALE
  );
}

/**
 * @param {Candidate[]} candidates
 * @param {OrderedCandidate[]} ordered
 * @param {number} splitIndex
 * @returns {[Candidate[],Candidate[]]}
 */
function partitionCandidates(candidates, ordered, splitIndex) {
  const firstBand = new Set(
    ordered.slice(0, splitIndex).map((item) => item.candidate),
  );
  const secondBand = new Set(
    ordered.slice(splitIndex).map((item) => item.candidate),
  );
  return [
    candidates.filter((candidate) => firstBand.has(candidate)),
    candidates.filter((candidate) => secondBand.has(candidate)),
  ];
}

/**
 * @param {Fragment} source
 * @param {string} paddleGroupId
 * @param {Candidate[]} candidates
 * @param {number} bandIndex
 * @returns {Fragment|null}
 */
function buildSyntheticReadingBandFragment(
  source,
  paddleGroupId,
  candidates,
  bandIndex,
) {
  const boxes = candidates.map(readBox);
  if (boxes.some((box) => box === null)) return null;
  const syntheticFragmentId = `${source.fragmentId}::band::${bandIndex}`;
  return {
    fragmentId: syntheticFragmentId,
    sourceFragmentId: source.fragmentId,
    syntheticFragmentId,
    paddleGroupId,
    partitionKey: `band-${bandIndex}`,
    status: source.status,
    candidates,
    bbox: /** @type {Box[]} */ (boxes).reduce(unionBoxes),
  };
}

/** @param {Candidate[]} candidates */
function readUniformPaddleGroupId(candidates) {
  const values = candidates.map((candidate) =>
    typeof candidate.paddleGroupId === "string"
      ? candidate.paddleGroupId.trim()
      : "",
  );
  return values[0] && new Set(values).size === 1 ? values[0] : null;
}

/** @param {Candidate[]} candidates */
function hasCompletePaddleSidecar(candidates) {
  const expectedSize = candidates.length;
  const orders = candidates.map((candidate) => Number(candidate.paddleOrder));
  return (
    candidates.every(
      (candidate) =>
        Number(candidate.paddleGroupSize) === expectedSize &&
        Number.isInteger(candidate.paddleOrder) &&
        Number(candidate.paddleOrder) >= 1 &&
        Number(candidate.paddleOrder) <= expectedSize,
    ) && new Set(orders).size === expectedSize
  );
}

/** @param {Box[]} boxes */
function readUniformWritingMode(boxes) {
  const modes = boxes.map(readWritingMode);
  if (modes.every((mode) => mode === "vertical")) return "vertical";
  if (modes.every((mode) => mode === "horizontal")) return "horizontal";
  return null;
}

/** @param {Box} box */
function readWritingMode(box) {
  if (box.y2 - box.y1 >= (box.x2 - box.x1) * 1.2) return "vertical";
  if (box.x2 - box.x1 >= (box.y2 - box.y1) * 1.2) return "horizontal";
  return null;
}

/** @param {Box[]} boxes */
function readCharacterScale(boxes) {
  return median(
    boxes
      .map((box) => Math.min(box.x2 - box.x1, box.y2 - box.y1))
      .sort((left, right) => left - right),
  );
}

/** @param {number[]} sorted */
function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

module.exports = {
  buildCompleteReadingStartBandPartition,
};
