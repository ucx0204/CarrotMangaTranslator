// @ts-check

const {
  readDistinctAnimeTextRegionBarrierCandidatePair,
} = require("./anime-text-distinct-region-plan.cjs");
const {
  hasDeferredRubyGeometry,
  isNearHostHan,
} = require("./group-only-review-deferred-ruby-geometry.cjs");
const { boxArea } = require("./group-only-review-values.cjs");

/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").UpstreamFragment} UpstreamFragment */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

const MIN_RUBY_SATELLITES = 2;
const MAX_RUBY_SATELLITES = 8;
const MIN_HOST_AREA_SHARE = 0.9;
const MAX_RUBY_AREA_RATIO = 0.03;
const MAX_RUBY_CROSS_RATIO = 0.35;

/**
 * A confirmed vertical fragment can occasionally contain the main Han column
 * and several individually detected right-side ruby glyphs. Treat that shape
 * as a ruby cluster only when one Han candidate overwhelmingly dominates the
 * fragment and at least two strict single-kana satellites independently agree.
 * Once the cluster is established, it may absorb uniquely aligned deferred
 * singleton kana from an adjacent fragment. One small kana is never enough.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} labels
 * @param {Map<number,number>} candidateIndexById
 * @param {Map<string,ReviewCandidate[]>} fragmentMembers
 */
function attachDominantVerticalRubyClusterLabels(
  plan,
  labels,
  candidateIndexById,
  fragmentMembers,
) {
  const clusters = plan.upstreamFragments.flatMap((fragment) => {
    const members = fragmentMembers.get(fragment.fragment) ?? [];
    const cluster = readRubyCluster(fragment, members);
    return cluster ? [cluster] : [];
  });
  if (!clusters.length) return;

  const deferredByCluster = collectUniqueDeferredSatellites(
    plan,
    clusters,
    fragmentMembers,
  );
  for (const cluster of clusters) {
    const hostIndex = candidateIndexById.get(cluster.host.id);
    if (hostIndex === undefined || labels[hostIndex].role !== "body") continue;
    const hostGroup = labels[hostIndex].group;
    attachRubyCandidates(
      labels,
      candidateIndexById,
      cluster.satellites,
      hostGroup,
    );
    const deferred = deferredByCluster.get(cluster) ?? [];
    if (cluster.satellites.length + deferred.length <= MAX_RUBY_SATELLITES) {
      attachRubyCandidates(labels, candidateIndexById, deferred, hostGroup);
    }
  }
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function readRubyCluster(fragment, members) {
  if (
    !isConfirmedFragment(fragment, members) ||
    members.length < MIN_RUBY_SATELLITES + 1 ||
    members.length > MAX_RUBY_SATELLITES + 1
  ) {
    return null;
  }
  const hosts = members.filter((candidate) =>
    isDominantVerticalHanHost(candidate, members),
  );
  if (hosts.length !== 1) return null;
  const host = hosts[0];
  const satellites = members.filter((candidate) => candidate.id !== host.id);
  return satellites.every((satellite) => isStrictRubySatellite(satellite, host))
    ? { host, satellites }
    : null;
}

/** @param {ReviewCandidate} candidate @param {ReviewCandidate[]} members */
function isDominantVerticalHanHost(candidate, members) {
  const width = axisLength(candidate.bbox, "x");
  const height = axisLength(candidate.bbox, "y");
  const totalArea = members.reduce(
    (sum, member) => sum + boxArea(member.bbox),
    0,
  );
  return (
    countHan(candidate.text) >= 2 &&
    height >= width * 1.4 &&
    boxArea(candidate.bbox) / Math.max(1, totalArea) >= MIN_HOST_AREA_SHARE
  );
}

/** @param {ReviewCandidate} satellite @param {ReviewCandidate} host */
function isStrictRubySatellite(satellite, host) {
  return (
    isSingleKana(satellite.text) &&
    axisLength(satellite.bbox, "x") / axisLength(host.bbox, "x") <=
      MAX_RUBY_CROSS_RATIO &&
    boxArea(satellite.bbox) / Math.max(1, boxArea(host.bbox)) <=
      MAX_RUBY_AREA_RATIO &&
    hasDeferredRubyGeometry(satellite.bbox, host.bbox, "vertical", true) &&
    isNearHostHan(satellite.bbox, [host], "vertical")
  );
}

/**
 * @param {ReviewPlan} plan
 * @param {Array<{host:ReviewCandidate;satellites:ReviewCandidate[]}>} clusters
 * @param {Map<string,ReviewCandidate[]>} fragmentMembers
 */
function collectUniqueDeferredSatellites(plan, clusters, fragmentMembers) {
  /** @type {Map<{host:ReviewCandidate;satellites:ReviewCandidate[]},ReviewCandidate[]>} */
  const result = new Map(clusters.map((cluster) => [cluster, []]));
  for (const fragment of plan.upstreamFragments) {
    const members = fragmentMembers.get(fragment.fragment) ?? [];
    const satellite = readDeferredSatellite(fragment, members);
    if (!satellite) continue;
    const matches = clusters.filter(
      (cluster) =>
        isStrictRubySatellite(satellite, cluster.host) &&
        !pairCrossesDistinctRegionBarrier(
          plan,
          [satellite.id],
          [cluster.host.id],
        ),
    );
    if (matches.length === 1) result.get(matches[0])?.push(satellite);
  }
  return result;
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function readDeferredSatellite(fragment, members) {
  if (members.length !== 1 || !isDeferredFragment(fragment, members))
    return null;
  const candidate = members[0];
  return hasReason(candidate, "dense_page_single_glyph") &&
    isSingleKana(candidate.text)
    ? candidate
    : null;
}

/** @param {ReviewLabel[]} labels @param {Map<number,number>} candidateIndexById @param {ReviewCandidate[]} candidates @param {number} hostGroup */
function attachRubyCandidates(
  labels,
  candidateIndexById,
  candidates,
  hostGroup,
) {
  for (const candidate of candidates) {
    const index = candidateIndexById.get(candidate.id);
    if (index !== undefined) labels[index] = { group: hostGroup, role: "ruby" };
  }
}

/** @param {UpstreamFragment} fragment @param {ReviewCandidate[]} members */
function isDeferredFragment(fragment, members) {
  return (
    fragment.status === "deferred" ||
    members.every((candidate) => candidate.hint.reviewStatus === "deferred")
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

/** @param {ReviewCandidate} candidate @param {string} reason */
function hasReason(candidate, reason) {
  const value = candidate.hint.reviewReasons;
  const reasons = Array.isArray(value)
    ? value.map(String)
    : [String(value ?? "")];
  return reasons.includes(reason);
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

/** @param {import("./group-only-review-types").Box} box @param {"x"|"y"} axis */
function axisLength(box, axis) {
  return Math.max(1, box[`${axis}2`] - box[`${axis}1`]);
}

/** @param {string} text */
function countHan(text) {
  return Array.from(text).filter((character) =>
    /\p{Script=Han}/u.test(character),
  ).length;
}

/** @param {string} text */
function isSingleKana(text) {
  const compact = text.replace(/\s/g, "");
  return (
    Array.from(compact).length === 1 &&
    /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(compact)
  );
}

module.exports = { attachDominantVerticalRubyClusterLabels };
