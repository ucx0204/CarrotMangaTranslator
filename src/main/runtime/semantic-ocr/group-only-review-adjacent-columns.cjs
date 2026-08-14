// @ts-check

const {
  axisCenter: center,
  axisGap,
  axisLength,
  axisOverlapRatio,
  boxArea,
  unionBoxes,
} = require("./box-geometry.cjs");
const {
  pairCrossesDistinctRegionBarrier,
} = require("./group-only-review-plan.cjs");

/** @typedef {import("./group-only-review-types").Box} Box */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */
/** @typedef {import("./group-only-review-types").UpstreamFragment} UpstreamFragment */
/** @typedef {{candidate:ReviewCandidate;role:"body"|"ruby"}} GroupMember */
/** @typedef {{group:number;reviewContextId:string;candidateIds:number[];body:ReviewCandidate}} ColumnGroup */

const MIN_BODY_VERTICAL_RATIO = 2.4;
const MIN_COLUMN_Y_OVERLAP = 0.45;
const MIN_COLUMN_CENTER_GAP_RATIO = 0.55;
const MAX_COLUMN_CENTER_GAP_RATIO = 1.25;
const MAX_COLUMN_X_GAP_RATIO = 0.15;
const MAX_COLUMN_START_OFFSET_RATIO = 0.65;
const MAX_RUBY_AREA_RATIO = 0.35;
const MIN_RUBY_RIGHT_OFFSET_RATIO = 0.25;
const MIN_RUBY_Y_OVERLAP = 0.1;

/**
 * Weakly reunite one very specific split-balloon shape: one review crop has
 * exactly two confirmed, adjacent Japanese vertical body columns, and each
 * column carries its own already-established ruby. The ruby evidence and
 * staggered right-to-left column geometry are required together so ordinary
 * nearby text, cries, effects, and separate compartments remain untouched.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} labels
 * @returns {ReviewLabel[]}
 */
function mergeAdjacentVerticalRubyColumns(plan, labels) {
  const result = labels.map((label) => ({ ...label }));
  const candidateIndexById = new Map(
    plan.candidates.map((candidate, index) => [candidate.id, index]),
  );
  const fragmentByCandidateId = indexConfirmedFragments(plan);
  const groups = collectGroups(plan, result, fragmentByCandidateId);
  /** @type {Map<string,ColumnGroup[]>} */
  const byContext = new Map();
  for (const group of groups) {
    if (!group) continue;
    const contextGroups = byContext.get(group.reviewContextId) ?? [];
    contextGroups.push(group);
    byContext.set(group.reviewContextId, contextGroups);
  }
  for (const [reviewContextId, contextGroups] of byContext) {
    mergeContextColumnPair(
      plan,
      result,
      candidateIndexById,
      reviewContextId,
      contextGroups,
    );
  }
  return result;
}

/**
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} result
 * @param {Map<number,number>} candidateIndexById
 * @param {string} reviewContextId
 * @param {ColumnGroup[]} contextGroups
 */
function mergeContextColumnPair(
  plan,
  result,
  candidateIndexById,
  reviewContextId,
  contextGroups,
) {
  if (contextGroups.length !== 2) return;
  const contextCandidateIds = plan.candidates
    .filter(
      (candidate) =>
        readCandidateString(candidate, "reviewContextId") === reviewContextId,
    )
    .map((candidate) => candidate.id);
  const groupedIds = contextGroups.flatMap((group) => group.candidateIds);
  if (!sameIntegerSet(contextCandidateIds, groupedIds)) return;
  const [first, second] = contextGroups;
  if (!isAdjacentVerticalColumnPair(first, second)) return;
  if (
    pairCrossesDistinctRegionBarrier(
      plan,
      first.candidateIds,
      second.candidateIds,
    )
  ) {
    return;
  }
  const right =
    center(first.body.bbox, "x") >= center(second.body.bbox, "x")
      ? first
      : second;
  const left = right === first ? second : first;
  if (
    right.body.bbox.y1 >
    left.body.bbox.y1 + axisLength(left.body.bbox, "y") * 0.15
  ) {
    return;
  }
  for (const id of groupedIds) {
    const index = candidateIndexById.get(id);
    if (index !== undefined) result[index].group = right.group;
  }
}

/** @param {ReviewPlan} plan @returns {Map<number,UpstreamFragment>} */
function indexConfirmedFragments(plan) {
  /** @type {Map<number,UpstreamFragment>} */
  const result = new Map();
  for (const fragment of plan.upstreamFragments) {
    if (fragment.status !== "confirmed") continue;
    for (const id of fragment.candidateIds) result.set(id, fragment);
  }
  return result;
}

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels @param {Map<number,UpstreamFragment>} fragmentByCandidateId @returns {Array<ColumnGroup|null>} */
function collectGroups(plan, labels, fragmentByCandidateId) {
  /** @type {Map<number,GroupMember[]>} */
  const membersByGroup = new Map();
  plan.candidates.forEach((candidate, index) => {
    const members = membersByGroup.get(labels[index].group) ?? [];
    members.push({ candidate, role: labels[index].role });
    membersByGroup.set(labels[index].group, members);
  });
  return [...membersByGroup].map(([group, members]) => {
    const body = members.filter((member) => member.role === "body");
    const ruby = members.filter((member) => member.role === "ruby");
    if (body.length !== 1 || ruby.length < 1 || ruby.length > 3) return null;
    const candidateIds = members.map((member) => member.candidate.id);
    const fragments = new Set(
      candidateIds.map((id) => fragmentByCandidateId.get(id)),
    );
    if (fragments.size !== 1 || fragments.has(undefined)) return null;
    const fragment = [...fragments][0];
    if (!fragment || !sameIntegerSet(candidateIds, fragment.candidateIds)) {
      return null;
    }
    const contexts = new Set(
      members.map((member) =>
        readCandidateString(member.candidate, "reviewContextId"),
      ),
    );
    if (contexts.size !== 1 || contexts.has(null)) return null;
    if (!isVerticalBodyWithRuby(body[0].candidate, ruby)) return null;
    return {
      group,
      reviewContextId: /** @type {string} */ ([...contexts][0]),
      candidateIds,
      body: body[0].candidate,
    };
  });
}

/** @param {ReviewCandidate} body @param {GroupMember[]} ruby */
function isVerticalBodyWithRuby(body, ruby) {
  const width = axisLength(body.bbox, "x");
  const height = axisLength(body.bbox, "y");
  if (height < width * MIN_BODY_VERTICAL_RATIO) return false;
  return ruby.every(({ candidate }) => {
    const rightOffset = center(candidate.bbox, "x") - center(body.bbox, "x");
    return (
      boxArea(candidate.bbox) / Math.max(1, boxArea(body.bbox)) <=
        MAX_RUBY_AREA_RATIO &&
      rightOffset >= width * MIN_RUBY_RIGHT_OFFSET_RATIO &&
      axisOverlapRatio(candidate.bbox, body.bbox, "y") >= MIN_RUBY_Y_OVERLAP
    );
  });
}

/** @param {ColumnGroup} first @param {ColumnGroup} second */
function isAdjacentVerticalColumnPair(first, second) {
  if (!first || !second) return false;
  const firstBox = first.body.bbox;
  const secondBox = second.body.bbox;
  const firstWidth = axisLength(firstBox, "x");
  const secondWidth = axisLength(secondBox, "x");
  const firstHeight = axisLength(firstBox, "y");
  const secondHeight = axisLength(secondBox, "y");
  const centerGap = Math.abs(center(firstBox, "x") - center(secondBox, "x"));
  const startOffset = Math.abs(firstBox.y1 - secondBox.y1);
  const union = unionBoxes([firstBox, secondBox]);
  return (
    axisOverlapRatio(firstBox, secondBox, "y") >= MIN_COLUMN_Y_OVERLAP &&
    axisGap(firstBox, secondBox, "x") <=
      Math.max(firstWidth, secondWidth) * MAX_COLUMN_X_GAP_RATIO &&
    centerGap >=
      Math.min(firstWidth, secondWidth) * MIN_COLUMN_CENTER_GAP_RATIO &&
    centerGap <=
      Math.max(firstWidth, secondWidth) * MAX_COLUMN_CENTER_GAP_RATIO &&
    startOffset <=
      Math.max(firstHeight, secondHeight) * MAX_COLUMN_START_OFFSET_RATIO &&
    axisLength(union, "y") >= axisLength(union, "x") * 2
  );
}

/** @param {ReviewCandidate} candidate @param {string} key */
function readCandidateString(candidate, key) {
  const value = candidate.hint[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {number[]} left @param {number[]} right */
function sameIntegerSet(left, right) {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

module.exports = { mergeAdjacentVerticalRubyColumns };
