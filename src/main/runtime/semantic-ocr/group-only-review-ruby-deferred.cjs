// @ts-check

const {
  readDistinctAnimeTextRegionBarrierCandidatePair,
} = require("./anime-text-distinct-region-plan.cjs");
const {
  hasDeferredRubyGeometry,
  isNearHostHan,
} = require("./group-only-review-deferred-ruby-geometry.cjs");
const { unionBoxes } = require("./group-only-review-values.cjs");

/** @typedef {import("./group-only-review-types").Box} Box */
/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").UpstreamFragment} UpstreamFragment */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

const MIN_COMPLETE_RUBY_RUN = 2;
const MAX_COMPLETE_RUBY_RUN = 8;

/**
 * Attach only two narrowly identified deferred-ruby shapes:
 * 1) a complete Paddle group made from an immediately preceding single-kana
 *    run and one ordinary Han host fragment; or
 * 2) one no-lineage single kana with one uniquely aligned horizontal Han host.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} labels
 * @param {Map<number,number>} candidateIndexById
 */
function attachDeferredRubyLabels(plan, labels, candidateIndexById) {
  const result = labels.map((label) => ({ ...label }));
  const fragmentByCandidateId = indexFragmentsByCandidateId(plan);
  attachCompletePaddleRubyRuns(
    plan,
    result,
    candidateIndexById,
    fragmentByCandidateId,
  );
  attachUniqueNoLineageRuby(
    plan,
    result,
    candidateIndexById,
    fragmentByCandidateId,
  );
  return result;
}

/** @param {ReviewPlan} plan */
function indexFragmentsByCandidateId(plan) {
  /** @type {Map<number,UpstreamFragment>} */
  const result = new Map();
  for (const fragment of plan.upstreamFragments)
    for (const id of fragment.candidateIds) result.set(id, fragment);
  return result;
}

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels @param {Map<number,number>} candidateIndexById @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function attachCompletePaddleRubyRuns(
  plan,
  labels,
  candidateIndexById,
  fragmentByCandidateId,
) {
  for (const candidates of collectPaddleGroups(plan).values()) {
    const match = readCompletePaddleRubyRun(candidates, fragmentByCandidateId);
    if (!match) continue;
    attachRubyMatch(plan, labels, candidateIndexById, match);
  }
}

/** @param {ReviewPlan} plan */
function collectPaddleGroups(plan) {
  /** @type {Map<string,ReviewCandidate[]>} */
  const result = new Map();
  for (const candidate of plan.candidates) {
    if (!candidate.paddleGroup) continue;
    const members = result.get(candidate.paddleGroup) ?? [];
    members.push(candidate);
    result.set(candidate.paddleGroup, members);
  }
  return result;
}

/** @param {ReviewCandidate[]} candidates @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function readCompletePaddleRubyRun(candidates, fragmentByCandidateId) {
  if (!isCompletePaddleGroup(candidates) || !hasUniformContext(candidates))
    return null;
  const fragments = uniqueFragments(candidates, fragmentByCandidateId);
  const hosts = fragments.flatMap((fragment) => {
    const members = membersOfFragment(candidates, fragment);
    return isDeferredOrdinaryHost(fragment, members)
      ? [{ fragment, members }]
      : [];
  });
  if (hosts.length !== 1) return null;
  const host = hosts[0];
  const satellites = candidates
    .filter((candidate) => !host.fragment.candidateIds.includes(candidate.id))
    .sort(comparePaddleOrder);
  if (!isCompleteDeferredRubyRun(satellites, fragmentByCandidateId))
    return null;
  if (!ordersImmediatelyPrecede(satellites, host.members)) return null;
  const mode = strictReadingMode(unionBoxes(host.members.map(readBox)), 1.4);
  if (!mode) return null;
  const satelliteBox = unionBoxes(satellites.map(readBox));
  const hostBox = unionBoxes(host.members.map(readBox));
  return hasDeferredRubyGeometry(satelliteBox, hostBox, mode, false) &&
    isNearHostHan(satelliteBox, host.members, mode)
    ? { satellites, hosts: host.members }
    : null;
}

/** @param {ReviewCandidate[]} candidates */
function isCompletePaddleGroup(candidates) {
  const sizes = new Set(
    candidates.map((candidate) =>
      readPositiveHint(candidate, "paddleGroupSize"),
    ),
  );
  const orders = candidates
    .map((candidate) => candidate.paddleOrder)
    .sort((left, right) => Number(left) - Number(right));
  return (
    sizes.size === 1 &&
    [...sizes][0] === candidates.length &&
    orders.every((order, index) => order === index + 1)
  );
}

/** @param {ReviewCandidate[]} candidates */
function hasUniformContext(candidates) {
  return (
    new Set(
      candidates.map((candidate) =>
        readCandidateString(candidate, "reviewContextId"),
      ),
    ).size === 1
  );
}

/** @param {ReviewCandidate[]} candidates @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function uniqueFragments(candidates, fragmentByCandidateId) {
  return [
    ...new Set(
      candidates.flatMap((candidate) => {
        const fragment = fragmentByCandidateId.get(candidate.id);
        return fragment ? [fragment] : [];
      }),
    ),
  ];
}

/** @param {ReviewCandidate[]} candidates @param {UpstreamFragment} fragment */
function membersOfFragment(candidates, fragment) {
  return fragment.candidateIds.flatMap((id) => {
    const candidate = candidates.find((item) => item.id === id);
    return candidate ? [candidate] : [];
  });
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function isDeferredOrdinaryHost(fragment, members) {
  return (
    members.length === fragment.candidateIds.length &&
    isDeferredFragment(fragment, members) &&
    members.every((candidate) =>
      hasReason(candidate, "ordinary_axis_candidate"),
    ) &&
    members.some((candidate) => containsHan(candidate.text))
  );
}

/** @param {ReviewCandidate[]} satellites @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function isCompleteDeferredRubyRun(satellites, fragmentByCandidateId) {
  if (
    satellites.length < MIN_COMPLETE_RUBY_RUN ||
    satellites.length > MAX_COMPLETE_RUBY_RUN
  ) {
    return false;
  }
  return satellites.every((candidate) => {
    const fragment = fragmentByCandidateId.get(candidate.id);
    return (
      fragment?.candidateIds.length === 1 &&
      isDeferredFragment(fragment, [candidate]) &&
      hasReason(candidate, "dense_page_single_glyph") &&
      isSingleKana(candidate.text)
    );
  });
}

/** @param {ReviewCandidate[]} satellites @param {ReviewCandidate[]} hosts */
function ordersImmediatelyPrecede(satellites, hosts) {
  const satelliteOrders = satellites.map(readPaddleOrder);
  const hostOrders = hosts.map(readPaddleOrder).sort((a, b) => a - b);
  if (satelliteOrders.some(Number.isNaN) || hostOrders.some(Number.isNaN))
    return false;
  return (
    satelliteOrders.every((order, index) => order === index + 1) &&
    hostOrders.every((order, index) => order === satellites.length + index + 1)
  );
}

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels @param {Map<number,number>} candidateIndexById @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function attachUniqueNoLineageRuby(
  plan,
  labels,
  candidateIndexById,
  fragmentByCandidateId,
) {
  for (const satellite of plan.candidates) {
    if (!isNoLineageRubySatellite(satellite, fragmentByCandidateId)) continue;
    const hosts = plan.candidates.filter((host) =>
      isUniqueNoLineageHost(plan, satellite, host, fragmentByCandidateId),
    );
    if (hosts.length !== 1) continue;
    attachRubyMatch(plan, labels, candidateIndexById, {
      satellites: [satellite],
      hosts,
    });
  }
}

/** @param {ReviewCandidate} candidate @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function isNoLineageRubySatellite(candidate, fragmentByCandidateId) {
  const fragment = fragmentByCandidateId.get(candidate.id);
  return (
    !candidate.paddleGroup &&
    !readCandidateString(candidate, "reviewContextId") &&
    fragment?.candidateIds.length === 1 &&
    isDeferredFragment(fragment, [candidate]) &&
    hasReason(candidate, "dense_page_single_glyph") &&
    isSingleKana(candidate.text)
  );
}

/** @param {ReviewPlan} plan @param {ReviewCandidate} satellite @param {ReviewCandidate} host @param {Map<number,UpstreamFragment>} fragmentByCandidateId */
function isUniqueNoLineageHost(plan, satellite, host, fragmentByCandidateId) {
  const fragment = fragmentByCandidateId.get(host.id);
  const mode = strictReadingMode(host.bbox, 1.4);
  return (
    satellite.id !== host.id &&
    !host.paddleGroup &&
    !readCandidateString(host, "reviewContextId") &&
    fragment?.candidateIds.length === 1 &&
    isDeferredOrdinaryHost(/** @type {UpstreamFragment} */ (fragment), [
      host,
    ]) &&
    mode === "horizontal" &&
    hasDeferredRubyGeometry(satellite.bbox, host.bbox, mode, true) &&
    isNearHostHan(satellite.bbox, [host], mode) &&
    !pairCrossesDistinctRegionBarrier(plan, [satellite.id], [host.id])
  );
}

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels @param {Map<number,number>} candidateIndexById @param {{satellites:ReviewCandidate[];hosts:ReviewCandidate[]}} match */
function attachRubyMatch(plan, labels, candidateIndexById, match) {
  if (
    pairCrossesDistinctRegionBarrier(
      plan,
      match.satellites.map((item) => item.id),
      match.hosts.map((item) => item.id),
    )
  ) {
    return;
  }
  const hostGroup = readUniformBodyGroup(
    match.hosts,
    labels,
    candidateIndexById,
  );
  if (hostGroup === null) return;
  for (const satellite of match.satellites) {
    const index = candidateIndexById.get(satellite.id);
    if (index !== undefined) labels[index] = { group: hostGroup, role: "ruby" };
  }
}

/** @param {ReviewCandidate[]} hosts @param {ReviewLabel[]} labels @param {Map<number,number>} candidateIndexById */
function readUniformBodyGroup(hosts, labels, candidateIndexById) {
  const hostLabels = hosts.flatMap((host) => {
    const index = candidateIndexById.get(host.id);
    return index === undefined ? [] : [labels[index]];
  });
  const groups = new Set(hostLabels.map((label) => label.group));
  return hostLabels.length === hosts.length &&
    hostLabels.every((label) => label.role === "body") &&
    groups.size === 1
    ? [...groups][0]
    : null;
}

/** @param {ReviewCandidate} candidate @param {string} reason */
function hasReason(candidate, reason) {
  const value = candidate.hint.reviewReasons;
  const reasons = Array.isArray(value)
    ? value.map(String)
    : [String(value ?? "")];
  return reasons.includes(reason);
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function isDeferredFragment(fragment, members) {
  return (
    fragment.status === "deferred" &&
    members.length > 0 &&
    members.every((candidate) => candidate.hint.reviewStatus === "deferred")
  );
}

/** @param {ReviewPlan} plan @param {number[]} leftIds @param {number[]} rightIds */
function pairCrossesDistinctRegionBarrier(plan, leftIds, rightIds) {
  const relations = Array.isArray(
    plan.spatialRelations.distinctAnimeTextRegionBarriers,
  )
    ? plan.spatialRelations.distinctAnimeTextRegionBarriers
    : [];
  for (const relation of relations) {
    const pair = readDistinctAnimeTextRegionBarrierCandidatePair(
      plan,
      relation,
    );
    if (!pair) continue;
    const forward =
      leftIds.some((id) => pair[0].includes(id)) &&
      rightIds.some((id) => pair[1].includes(id));
    const reverse =
      leftIds.some((id) => pair[1].includes(id)) &&
      rightIds.some((id) => pair[0].includes(id));
    if (forward || reverse) return true;
  }
  return false;
}

/** @param {ReviewCandidate} candidate @param {string} key */
function readCandidateString(candidate, key) {
  const value = candidate.hint[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {ReviewCandidate} candidate @param {string} key */
function readPositiveHint(candidate, key) {
  const value = Number(candidate.hint[key]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** @param {ReviewCandidate} candidate */
function readPaddleOrder(candidate) {
  return candidate.paddleOrder ?? Number.NaN;
}

/** @param {ReviewCandidate} left @param {ReviewCandidate} right */
function comparePaddleOrder(left, right) {
  return readPaddleOrder(left) - readPaddleOrder(right);
}

/** @param {ReviewCandidate} candidate */
function readBox(candidate) {
  return candidate.bbox;
}

/** @param {Box} box @param {number} ratio */
function strictReadingMode(box, ratio) {
  const width = axisLength(box, "x");
  const height = axisLength(box, "y");
  if (height >= width * ratio) return "vertical";
  if (width >= height * ratio) return "horizontal";
  return null;
}

/** @param {Box} box @param {"x"|"y"} axis */
function axisLength(box, axis) {
  return Math.max(1, box[`${axis}2`] - box[`${axis}1`]);
}

/** @param {string} text */
function containsHan(text) {
  return /\p{Script=Han}/u.test(text);
}

/** @param {string} text */
function isSingleKana(text) {
  const compact = text.replace(/\s/g, "");
  return (
    Array.from(compact).length === 1 &&
    /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(compact)
  );
}

module.exports = { attachDeferredRubyLabels };
