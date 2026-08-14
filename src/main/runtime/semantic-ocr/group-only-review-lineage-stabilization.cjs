// @ts-check

const {
  axisCenter: boxCenter,
  axisGap: axisGapBoxes,
  axisLength: axisLengthBox,
  axisOverlapRatio,
  boxArea,
  unionBoxes,
} = require("./box-geometry.cjs");
const {
  pairCrossesDistinctRegionBarrier,
} = require("./group-only-review-plan.cjs");

/** @typedef {import("./group-only-review-types").Box} Box */
/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").UpstreamFragment} UpstreamFragment */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

const MIN_FRAGMENT_ORIENTATION_RATIO = 1.4;
const MIN_FRAGMENT_ALONG_AXIS_OVERLAP = 0.78;
const MAX_FRAGMENT_CROSS_AXIS_GAP_RATIO = 0.35;
const MAX_FRAGMENT_PADDLE_ORDER_GAP = 2;
const MAX_STRICT_RUBY_CROSS_AXIS_RATIO = 0.62;
const MAX_STRICT_RUBY_AREA_RATIO = 0.5;
const MIN_STRICT_RUBY_ALONG_AXIS_OVERLAP = 0.78;
const MAX_STRICT_RUBY_CROSS_AXIS_GAP_RATIO = 0.45;
const MIN_STRICT_RUBY_CENTER_OFFSET_RATIO = 0.2;
const MAX_STRICT_RUBY_PADDLE_ORDER_DELTA = 2;

/**
 * Recover a split only when exactly two confirmed fragments share an explicit
 * review context, one Paddle lineage, consecutive Paddle order, and strongly
 * aligned touching/adjacent geometry. Proximity alone is never sufficient.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} labels
 * @returns {ReviewLabel[]}
 */
function mergeStrongLineageFragmentSplits(plan, labels) {
  const result = labels.map((label) => ({ ...label }));
  const candidateById = new Map(
    plan.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const candidateIndexById = new Map(
    plan.candidates.map((candidate, index) => [candidate.id, index]),
  );
  const byLineage = indexStrongLineageFragments(plan, candidateById);
  for (const fragments of byLineage.values()) {
    applyStrongLineagePair(plan, fragments, result, candidateIndexById);
  }
  return result;
}

/**
 * @param {ReviewPlan} plan
 * @param {Map<number,ReviewCandidate>} candidateById
 */
function indexStrongLineageFragments(plan, candidateById) {
  /** @type {Map<string,Array<NonNullable<ReturnType<typeof buildStrongLineageFragmentEvidence>>>>} */
  const byLineage = new Map();
  for (const fragment of plan.upstreamFragments) {
    const members = fragment.candidateIds.flatMap((id) => {
      const candidate = candidateById.get(id);
      return candidate ? [candidate] : [];
    });
    const item = buildStrongLineageFragmentEvidence(fragment, members);
    if (!item) continue;
    const key = `${item.reviewContextId}\u0000${item.paddleGroupId}`;
    const lineage = byLineage.get(key) ?? [];
    lineage.push(item);
    byLineage.set(key, lineage);
  }
  return byLineage;
}

/**
 * @param {ReviewPlan} plan
 * @param {Array<NonNullable<ReturnType<typeof buildStrongLineageFragmentEvidence>>>} fragments
 * @param {ReviewLabel[]} result
 * @param {Map<number,number>} candidateIndexById
 */
function applyStrongLineagePair(plan, fragments, result, candidateIndexById) {
  if (fragments.length !== 2) return;
  const [left, right] = fragments;
  if (!isStrongLineageFragmentPair(left, right)) return;
  if (
    pairCrossesDistinctRegionBarrier(
      plan,
      left.candidateIds,
      right.candidateIds,
    )
  ) {
    return;
  }
  const leftIndex = candidateIndexById.get(left.candidateIds[0]);
  const rightIndex = candidateIndexById.get(right.candidateIds[0]);
  if (leftIndex === undefined || rightIndex === undefined) return;
  const leftGroup = result[leftIndex].group;
  const rightGroup = result[rightIndex].group;
  if (leftGroup === rightGroup) return;
  const targetGroup =
    left.minimumPaddleOrder <= right.minimumPaddleOrder
      ? leftGroup
      : rightGroup;
  for (const id of [...left.candidateIds, ...right.candidateIds]) {
    const index = candidateIndexById.get(id);
    if (index !== undefined) result[index].group = targetGroup;
  }
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function buildStrongLineageFragmentEvidence(fragment, members) {
  if (!isConfirmedFragment(fragment, members)) return null;
  if (members.some(hasPriorRubyEvidence)) return null;
  const reviewContextId = readUniformCandidateString(
    members,
    "reviewContextId",
  );
  const paddleGroupId = readUniformCandidatePaddleGroup(members);
  const paddleOrders = members.map((candidate) => candidate.paddleOrder);
  if (!hasValidFragmentLineage(reviewContextId, paddleGroupId, paddleOrders)) {
    return null;
  }
  const bbox = unionBoxes(members.map((candidate) => candidate.bbox));
  const mode = strictReadingMode(bbox, MIN_FRAGMENT_ORIENTATION_RATIO);
  if (!mode) return null;
  const orders = /** @type {number[]} */ (paddleOrders);
  return {
    candidateIds: members.map((candidate) => candidate.id),
    bbox,
    mode,
    reviewContextId: /** @type {string} */ (reviewContextId),
    paddleGroupId: /** @type {string} */ (paddleGroupId),
    minimumPaddleOrder: Math.min(...orders),
    maximumPaddleOrder: Math.max(...orders),
  };
}

/** @param {ReviewCandidate} candidate */
function hasPriorRubyEvidence(candidate) {
  return candidate.hint.reviewRole === "ruby" || candidate.hint.role === "ruby";
}

/** @param {string|null} context @param {string|null} paddle @param {Array<number|null>} orders */
function hasValidFragmentLineage(context, paddle, orders) {
  return (
    Boolean(context && /^RC\d{3,4}$/.test(context)) &&
    Boolean(paddle) &&
    orders.every((value) => value !== null) &&
    new Set(orders).size === orders.length
  );
}

/**
 * @param {NonNullable<ReturnType<typeof buildStrongLineageFragmentEvidence>>} left
 * @param {NonNullable<ReturnType<typeof buildStrongLineageFragmentEvidence>>} right
 */
function isStrongLineageFragmentPair(left, right) {
  if (!hasMatchingFragmentLineage(left, right)) return false;
  const along = left.mode === "vertical" ? "y" : "x";
  const cross = left.mode === "vertical" ? "x" : "y";
  const orderGap = Math.max(
    0,
    left.minimumPaddleOrder - right.maximumPaddleOrder,
    right.minimumPaddleOrder - left.maximumPaddleOrder,
  );
  const maximumCrossGap =
    Math.max(
      axisLengthBox(left.bbox, cross),
      axisLengthBox(right.bbox, cross),
    ) * MAX_FRAGMENT_CROSS_AXIS_GAP_RATIO;
  return (
    orderGap <= MAX_FRAGMENT_PADDLE_ORDER_GAP &&
    axisOverlapRatio(left.bbox, right.bbox, along) >=
      MIN_FRAGMENT_ALONG_AXIS_OVERLAP &&
    axisGapBoxes(left.bbox, right.bbox, cross) <= maximumCrossGap &&
    strictReadingMode(unionBoxes([left.bbox, right.bbox]), 1.2) === left.mode
  );
}

/**
 * @param {NonNullable<ReturnType<typeof buildStrongLineageFragmentEvidence>>} left
 * @param {NonNullable<ReturnType<typeof buildStrongLineageFragmentEvidence>>} right
 */
function hasMatchingFragmentLineage(left, right) {
  return (
    left.mode === right.mode &&
    left.reviewContextId === right.reviewContextId &&
    left.paddleGroupId === right.paddleGroupId
  );
}

/**
 * Recover confirmed short furigana only when it has one unique Han host and
 * every lineage, direction, size, overlap, side, gap, and order guard agrees.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} result
 * @param {Map<number,number>} candidateIndexById
 */
function attachStrictLineageRubyLabels(plan, result, candidateIndexById) {
  const confirmedIds = new Set(
    plan.upstreamFragments
      .filter((fragment) => fragment.status === "confirmed")
      .flatMap((fragment) => fragment.candidateIds),
  );
  for (const satellite of plan.candidates) {
    const satelliteIndex = candidateIndexById.get(satellite.id);
    if (
      !isEligibleRubySatellite(satellite, satelliteIndex, result, confirmedIds)
    ) {
      continue;
    }
    const hosts = findStrictRubyHosts(
      plan,
      satellite,
      result,
      candidateIndexById,
      confirmedIds,
    );
    if (hosts.length !== 1) continue;
    const hostIndex = candidateIndexById.get(hosts[0].id);
    if (hostIndex === undefined) continue;
    result[/** @type {number} */ (satelliteIndex)] = {
      group: result[hostIndex].group,
      role: "ruby",
    };
  }
}

/** @param {ReviewCandidate} candidate @param {number|undefined} index @param {ReviewLabel[]} labels @param {Set<number>} confirmedIds */
function isEligibleRubySatellite(candidate, index, labels, confirmedIds) {
  return (
    index !== undefined &&
    labels[index].role === "body" &&
    confirmedIds.has(candidate.id) &&
    isKanaReading(candidate.text)
  );
}

/** @param {ReviewPlan} plan @param {ReviewCandidate} satellite @param {ReviewLabel[]} labels @param {Map<number,number>} candidateIndexById @param {Set<number>} confirmedIds */
function findStrictRubyHosts(
  plan,
  satellite,
  labels,
  candidateIndexById,
  confirmedIds,
) {
  return plan.candidates.filter((host) => {
    const hostIndex = candidateIndexById.get(host.id);
    return (
      hostIndex !== undefined &&
      labels[hostIndex].role === "body" &&
      confirmedIds.has(host.id) &&
      isStrictLineageRubyPair(satellite, host) &&
      !pairCrossesDistinctRegionBarrier(plan, [satellite.id], [host.id])
    );
  });
}

/** @param {ReviewCandidate} satellite @param {ReviewCandidate} host */
function isStrictLineageRubyPair(satellite, host) {
  if (satellite.id === host.id || !containsHan(host.text)) return false;
  if (!hasMatchingRubyLineage(satellite, host)) return false;
  const mode = strictReadingMode(host.bbox, MIN_FRAGMENT_ORIENTATION_RATIO);
  if (!mode || strictReadingMode(satellite.bbox, 1.4) !== mode) return false;
  return hasStrictRubyGeometry(satellite.bbox, host.bbox, mode);
}

/** @param {ReviewCandidate} satellite @param {ReviewCandidate} host */
function hasMatchingRubyLineage(satellite, host) {
  const satelliteContext = readCandidateString(satellite, "reviewContextId");
  const hostContext = readCandidateString(host, "reviewContextId");
  const orderDelta =
    satellite.paddleOrder === null || host.paddleOrder === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(satellite.paddleOrder - host.paddleOrder);
  return (
    Boolean(satelliteContext) &&
    satelliteContext === hostContext &&
    Boolean(satellite.paddleGroup) &&
    satellite.paddleGroup === host.paddleGroup &&
    orderDelta <= MAX_STRICT_RUBY_PADDLE_ORDER_DELTA
  );
}

/** @param {Box} satellite @param {Box} host @param {"vertical"|"horizontal"} mode */
function hasStrictRubyGeometry(satellite, host, mode) {
  const along = mode === "vertical" ? "y" : "x";
  const cross = mode === "vertical" ? "x" : "y";
  const satelliteCross = axisLengthBox(satellite, cross);
  const hostCross = axisLengthBox(host, cross);
  const centerOffset =
    mode === "vertical"
      ? boxCenter(satellite, "x") - boxCenter(host, "x")
      : boxCenter(host, "y") - boxCenter(satellite, "y");
  return (
    satelliteCross / hostCross <= MAX_STRICT_RUBY_CROSS_AXIS_RATIO &&
    boxArea(satellite) / Math.max(1, boxArea(host)) <=
      MAX_STRICT_RUBY_AREA_RATIO &&
    axisOverlapRatio(satellite, host, along) >=
      MIN_STRICT_RUBY_ALONG_AXIS_OVERLAP &&
    axisGapBoxes(satellite, host, cross) <=
      hostCross * MAX_STRICT_RUBY_CROSS_AXIS_GAP_RATIO &&
    centerOffset >= hostCross * MIN_STRICT_RUBY_CENTER_OFFSET_RATIO
  );
}

/** @param {ReviewCandidate[]} candidates @param {string} key */
function readUniformCandidateString(candidates, key) {
  const values = new Set(
    candidates.map((candidate) => readCandidateString(candidate, key)),
  );
  return values.size === 1 ? [...values][0] : null;
}

/** @param {ReviewCandidate[]} candidates */
function readUniformCandidatePaddleGroup(candidates) {
  const values = new Set(candidates.map((candidate) => candidate.paddleGroup));
  return values.size === 1 ? [...values][0] : null;
}

/** @param {ReviewCandidate} candidate @param {string} key */
function readCandidateString(candidate, key) {
  const value = candidate.hint[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {Box} box @param {number} ratio */
function strictReadingMode(box, ratio) {
  const width = axisLengthBox(box, "x");
  const height = axisLengthBox(box, "y");
  if (height >= width * ratio) return "vertical";
  if (width >= height * ratio) return "horizontal";
  return null;
}

/** @param {string} text */
function containsHan(text) {
  return /\p{Script=Han}/u.test(text);
}

/** @param {string} text */
function isKanaReading(text) {
  const compact = text.replace(/[\s…!?！？。、〜～「」『』（）()]/g, "");
  const length = Array.from(compact).length;
  return (
    length >= 1 &&
    length <= 16 &&
    /^[\p{Script=Hiragana}\p{Script=Katakana}ー・]+$/u.test(compact)
  );
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function isConfirmedFragment(fragment, members) {
  return (
    members.length > 0 &&
    fragment.status === "confirmed" &&
    members.every((candidate) => candidate.hint.reviewStatus !== "deferred")
  );
}

module.exports = {
  attachStrictLineageRubyLabels,
  mergeStrongLineageFragmentSplits,
};
