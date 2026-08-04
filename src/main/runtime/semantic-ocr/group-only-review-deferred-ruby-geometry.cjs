// @ts-check

const {
  axisOverlapRatio,
  boxArea,
  unionBoxes,
} = require("./group-only-review-values.cjs");

/** @typedef {import("./group-only-review-types").Box} Box */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */

const COMPLETE_POLICY = {
  maxCrossRatio: 0.35,
  maxAreaRatio: 0.12,
  maxAlongRatio: Number.POSITIVE_INFINITY,
  minAlongOverlap: 0.85,
  minCenterOffset: 0.12,
  maxCrossGap: 0.25,
};
const NO_LINEAGE_POLICY = {
  maxCrossRatio: 0.45,
  maxAreaRatio: 0.05,
  maxAlongRatio: 0.15,
  minAlongOverlap: 0.95,
  minCenterOffset: 0.2,
  maxCrossGap: 0.05,
};
const MIN_RUBY_HAN_OVERLAP = 0.65;

/** @param {Box} satellite @param {Box} host @param {"vertical"|"horizontal"} mode @param {boolean} noLineage */
function hasDeferredRubyGeometry(satellite, host, mode, noLineage) {
  const policy = noLineage ? NO_LINEAGE_POLICY : COMPLETE_POLICY;
  const along = mode === "vertical" ? "y" : "x";
  const cross = mode === "vertical" ? "x" : "y";
  const satelliteAlong = axisLength(satellite, along);
  const hostAlong = axisLength(host, along);
  const satelliteCross = axisLength(satellite, cross);
  const hostCross = axisLength(host, cross);
  const centerOffset =
    mode === "vertical"
      ? boxCenter(satellite, "x") - boxCenter(host, "x")
      : boxCenter(host, "y") - boxCenter(satellite, "y");
  return (
    satelliteCross / hostCross <= policy.maxCrossRatio &&
    boxArea(satellite) / Math.max(1, boxArea(host)) <= policy.maxAreaRatio &&
    satelliteAlong / hostAlong <= policy.maxAlongRatio &&
    axisOverlapRatio(satellite, host, along) >= policy.minAlongOverlap &&
    axisGap(satellite, host, cross) <= hostCross * policy.maxCrossGap &&
    centerOffset >= hostCross * policy.minCenterOffset
  );
}

/** @param {Box} satellite @param {ReviewCandidate[]} hosts @param {"vertical"|"horizontal"} mode */
function isNearHostHan(satellite, hosts, mode) {
  const hanBoxes = hosts.flatMap((host) => approximateHanBoxes(host, mode));
  if (!hanBoxes.length) return false;
  const along = mode === "vertical" ? "y" : "x";
  return (
    axisOverlapRatio(satellite, unionBoxes(hanBoxes), along) >=
    MIN_RUBY_HAN_OVERLAP
  );
}

/** @param {ReviewCandidate} host @param {"vertical"|"horizontal"} mode */
function approximateHanBoxes(host, mode) {
  const characters = Array.from(host.text);
  return characters.flatMap((character, index) => {
    if (!/\p{Script=Han}/u.test(character)) return [];
    const startRatio = index / Math.max(1, characters.length);
    const endRatio = (index + 1) / Math.max(1, characters.length);
    if (mode === "horizontal") {
      const width = host.bbox.x2 - host.bbox.x1;
      return [
        {
          ...host.bbox,
          x1: host.bbox.x1 + width * startRatio,
          x2: host.bbox.x1 + width * endRatio,
        },
      ];
    }
    const height = host.bbox.y2 - host.bbox.y1;
    return [
      {
        ...host.bbox,
        y1: host.bbox.y1 + height * startRatio,
        y2: host.bbox.y1 + height * endRatio,
      },
    ];
  });
}

/** @param {Box} box @param {"x"|"y"} axis */
function axisLength(box, axis) {
  return Math.max(1, box[`${axis}2`] - box[`${axis}1`]);
}

/** @param {Box} left @param {Box} right @param {"x"|"y"} axis */
function axisGap(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return Math.max(0, left[start] - right[end], right[start] - left[end]);
}

/** @param {Box} box @param {"x"|"y"} axis */
function boxCenter(box, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return (box[start] + box[end]) / 2;
}

module.exports = { hasDeferredRubyGeometry, isNearHostHan };
