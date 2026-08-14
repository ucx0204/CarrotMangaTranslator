// @ts-check

/** @typedef {import("./group-only-review-types").Box} Box */

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
function axisCenter(box, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return (box[start] + box[end]) / 2;
}

/** @param {Box} left @param {Box} right @param {"x"|"y"} axis */
function axisOverlapRatio(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  const overlap = Math.max(
    0,
    Math.min(left[end], right[end]) - Math.max(left[start], right[start]),
  );
  return (
    overlap /
    Math.max(1, Math.min(left[end] - left[start], right[end] - right[start]))
  );
}

/** @param {Box} box */
function boxArea(box) {
  return Math.max(1, box.x2 - box.x1) * Math.max(1, box.y2 - box.y1);
}

/** @param {Box} left @param {Box} right */
function boxIntersectionArea(left, right) {
  return (
    Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1)) *
    Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1))
  );
}

/** @param {Box[]} boxes @returns {Box} */
function unionBoxes(boxes) {
  return {
    x1: Math.min(...boxes.map((box) => box.x1)),
    y1: Math.min(...boxes.map((box) => box.y1)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2)),
  };
}

/** @param {Box} left @param {Box} right @returns {Box} */
function unionBoxPair(left, right) {
  return {
    x1: Math.min(left.x1, right.x1),
    y1: Math.min(left.y1, right.y1),
    x2: Math.max(left.x2, right.x2),
    y2: Math.max(left.y2, right.y2),
  };
}

module.exports = {
  axisCenter,
  axisGap,
  axisLength,
  axisOverlapRatio,
  boxArea,
  boxIntersectionArea,
  unionBoxPair,
  unionBoxes,
};
