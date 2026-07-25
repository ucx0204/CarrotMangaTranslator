// @ts-check

/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */
/** @typedef {import("./group-only-review-types").ReviewProjection} ReviewProjection */

const MAX_RUBY_CROSS_AXIS_RATIO = 0.92;
const MAX_MISSING_RUBY_CROSS_AXIS_RATIO = 0.78;
const MIN_ALONG_AXIS_OVERLAP = 0.72;
const MAX_CROSS_AXIS_GAP_RATIO = 0.8;

/**
 * Most detector-qualified crops need only the relation-aware request. Ask for
 * a relation-free role baseline only when the returned roles contradict a
 * conservative geometric ruby sanity check.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewProjection} projection
 */
function requiresRelationFreeRoleBaseline(plan, projection) {
  const members = plan.candidates.map((candidate, index) => ({
    candidate,
    label: projection.labels[index],
  }));
  const groups = groupMembers(members);
  for (const group of groups.values()) {
    const bodies = group
      .filter((item) => item.label.role === "body")
      .map((item) => item.candidate);
    const rubies = group
      .filter((item) => item.label.role === "ruby")
      .map((item) => item.candidate);
    if (
      rubies.some(
        (ruby) =>
          !bodies.some((body) =>
            isPlausibleRubyPair(ruby, body, MAX_RUBY_CROSS_AXIS_RATIO),
          ),
      )
    ) {
      return true;
    }
    if (
      !hasConfirmedRuby(rubies) &&
      bodies.some(
        (candidate) =>
          isLongHiraganaReading(candidate.text) &&
          bodies.some(
            (host) =>
              host !== candidate &&
              isPlausibleRubyPair(
                candidate,
                host,
                MAX_MISSING_RUBY_CROSS_AXIS_RATIO,
              ),
          ),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Array<{candidate:ReviewCandidate;label:{group:number;role:string}}>} members
 */
function groupMembers(members) {
  /** @type {Map<number,typeof members>} */
  const groups = new Map();
  for (const member of members) {
    const group = groups.get(member.label.group) ?? [];
    group.push(member);
    groups.set(member.label.group, group);
  }
  return groups;
}

/** @param {ReviewCandidate[]} candidates */
function hasConfirmedRuby(candidates) {
  return candidates.some(
    (candidate) => candidate.hint.reviewStatus !== "deferred",
  );
}

/**
 * @param {ReviewCandidate} satellite
 * @param {ReviewCandidate} host
 * @param {number} maximumCrossAxisRatio
 */
function isPlausibleRubyPair(satellite, host, maximumCrossAxisRatio) {
  if (!containsHan(host.text)) return false;
  const mode = readingMode(host);
  if (!mode) return false;
  const cross = mode === "vertical" ? "x" : "y";
  const along = mode === "vertical" ? "y" : "x";
  const satelliteCross = axisLength(satellite, cross);
  const hostCross = axisLength(host, cross);
  return (
    satelliteCross / hostCross <= maximumCrossAxisRatio &&
    axisOverlap(satellite, host, along) >= MIN_ALONG_AXIS_OVERLAP &&
    axisGap(satellite, host, cross) <=
      Math.max(satelliteCross, hostCross) * MAX_CROSS_AXIS_GAP_RATIO
  );
}

/** @param {ReviewCandidate} candidate */
function readingMode(candidate) {
  const width = axisLength(candidate, "x");
  const height = axisLength(candidate, "y");
  if (height >= width * 1.4) return "vertical";
  if (width >= height * 1.4) return "horizontal";
  return null;
}

/** @param {ReviewCandidate} candidate @param {"x"|"y"} axis */
function axisLength(candidate, axis) {
  return Math.max(1, candidate.bbox[`${axis}2`] - candidate.bbox[`${axis}1`]);
}

/**
 * @param {ReviewCandidate} left
 * @param {ReviewCandidate} right
 * @param {"x"|"y"} axis
 */
function axisOverlap(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  const overlap = Math.max(
    0,
    Math.min(left.bbox[end], right.bbox[end]) -
      Math.max(left.bbox[start], right.bbox[start]),
  );
  return overlap / Math.min(axisLength(left, axis), axisLength(right, axis));
}

/**
 * @param {ReviewCandidate} left
 * @param {ReviewCandidate} right
 * @param {"x"|"y"} axis
 */
function axisGap(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return Math.max(
    0,
    left.bbox[start] - right.bbox[end],
    right.bbox[start] - left.bbox[end],
  );
}

/** @param {string} text */
function containsHan(text) {
  return /\p{Script=Han}/u.test(text);
}

/** @param {string} text */
function isLongHiraganaReading(text) {
  const compact = text.replace(/[\s…!?！？。、〜～]/g, "");
  return (
    Array.from(compact).length >= 4 &&
    /^[\p{Script=Hiragana}ー・]+$/u.test(compact)
  );
}

module.exports = { requiresRelationFreeRoleBaseline };
