// @ts-check

const {
  axisOverlapRatio,
  boxArea,
  boxIntersectionArea,
  unionBoxes,
} = require("./group-only-review-values.cjs");
const {
  attachDominantVerticalRubyClusterLabels,
} = require("./group-only-review-ruby-dominant.cjs");
const {
  attachStrictLineageRubyLabels,
} = require("./group-only-review-lineage-stabilization.cjs");
const {
  attachDeferredRubyLabels,
} = require("./group-only-review-ruby-deferred.cjs");

/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").UpstreamFragment} UpstreamFragment */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

/**
 * The model may merge confirmed fragments, but a tiny diagonal corner touch
 * between different Paddle lineages is not evidence that two balloons share
 * one text container. Split only that narrow case; aligned rows/columns,
 * shared Paddle ancestry, and deferred ruby fragments remain model-owned.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} labels
 * @returns {ReviewLabel[]}
 */
function separateWeakDiagonalFragmentMerges(plan, labels) {
  const result = labels.map((label) => ({ ...label }));
  const labelById = new Map(
    plan.candidates.map((candidate, index) => [candidate.id, result[index]]),
  );
  const candidateById = new Map(
    plan.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const candidateIndexById = new Map(
    plan.candidates.map((candidate, index) => [candidate.id, index]),
  );
  const freeGroups = Array.from(
    { length: plan.candidates.length },
    (_, index) => index + 1,
  ).filter((group) => !result.some((label) => label.group === group));
  const fragmentsByModelGroup = collectFragmentsByModelGroup(plan, labelById);

  for (const [modelGroup, fragments] of fragmentsByModelGroup) {
    const components = resolveWeakDiagonalComponents(
      fragments,
      modelGroup,
      candidateById,
      labelById,
    );
    if (!components || freeGroups.length < components.length - 1) {
      continue;
    }
    promoteBodylessConfirmedComponents(
      components,
      result,
      labelById,
      candidateIndexById,
    );
    assignSeparatedComponents(
      components,
      modelGroup,
      result,
      candidateIndexById,
      freeGroups,
    );
  }
  return result;
}

/**
 * @param {ReviewPlan} plan
 * @param {Map<number,ReviewLabel>} labelById
 */
function collectFragmentsByModelGroup(plan, labelById) {
  /** @type {Map<number,UpstreamFragment[]>} */
  const grouped = new Map();
  for (const fragment of plan.upstreamFragments) {
    const modelGroup = labelById.get(fragment.candidateIds[0])?.group;
    if (!modelGroup) continue;
    const members = grouped.get(modelGroup) ?? [];
    members.push(fragment);
    grouped.set(modelGroup, members);
  }
  return grouped;
}

/**
 * @param {UpstreamFragment[]} fragments
 * @param {number} modelGroup
 * @param {Map<number,ReviewCandidate>} candidateById
 * @param {Map<number,ReviewLabel>} labelById
 * @returns {Array<Array<ReturnType<typeof buildFragmentEvidence>>>|null}
 */
function resolveWeakDiagonalComponents(
  fragments,
  modelGroup,
  candidateById,
  labelById,
) {
  if (
    fragments.some(
      (fragment) => !isIntactReviewFragment(fragment, modelGroup, labelById),
    )
  ) {
    return null;
  }
  const evidence = fragments.map((fragment) =>
    buildFragmentEvidence(fragment, candidateById),
  );
  const confirmed = evidence.filter((item) => item.status === "confirmed");
  if (!hasSeparableConfirmedFragments(confirmed)) return null;
  const components = collectPreservedFragmentComponents(confirmed);
  if (components.length < 2) return null;
  const deferred = evidence.filter((item) => item.status === "deferred");
  return attachDeferredEvidence(components, deferred) ? components : null;
}

/**
 * @param {UpstreamFragment} fragment
 * @param {number} modelGroup
 * @param {Map<number,ReviewLabel>} labelById
 */
function isIntactReviewFragment(fragment, modelGroup, labelById) {
  return (
    ["confirmed", "deferred"].includes(fragment.status) &&
    fragment.candidateIds.every((id) => labelById.get(id)?.group === modelGroup)
  );
}

/** @param {Array<ReturnType<typeof buildFragmentEvidence>>} confirmed */
function hasSeparableConfirmedFragments(confirmed) {
  return (
    confirmed.length >= 2 &&
    confirmed.every(
      (item) => item.paddleGroups.size === 1 && item.candidateIds.length > 0,
    )
  );
}

/**
 * @param {Array<Array<ReturnType<typeof buildFragmentEvidence>>>} components
 * @param {Array<ReturnType<typeof buildFragmentEvidence>>} deferred
 */
function attachDeferredEvidence(components, deferred) {
  for (const item of deferred) {
    if (item.paddleGroups.size !== 1 || item.candidateIds.length === 0)
      return false;
    const paddleGroup = [...item.paddleGroups][0];
    const matching = components.filter((component) =>
      component.some((anchor) => anchor.paddleGroups.has(paddleGroup)),
    );
    if (matching.length !== 1) return false;
    matching[0].push(item);
  }
  return true;
}

/**
 * @param {Array<Array<ReturnType<typeof buildFragmentEvidence>>>} components
 * @param {ReviewLabel[]} result
 * @param {Map<number,ReviewLabel>} labelById
 * @param {Map<number,number>} candidateIndexById
 */
function promoteBodylessConfirmedComponents(
  components,
  result,
  labelById,
  candidateIndexById,
) {
  for (const component of components) {
    const componentIds = component.flatMap((item) => item.candidateIds);
    if (componentIds.some((id) => labelById.get(id)?.role === "body")) continue;
    const confirmedIds = component
      .filter((item) => item.status === "confirmed")
      .flatMap((item) => item.candidateIds);
    for (const id of confirmedIds) {
      const index = candidateIndexById.get(id);
      if (index !== undefined) result[index].role = "body";
    }
  }
}

/**
 * @param {Array<Array<ReturnType<typeof buildFragmentEvidence>>>} components
 * @param {number} modelGroup
 * @param {ReviewLabel[]} result
 * @param {Map<number,number>} candidateIndexById
 * @param {number[]} freeGroups
 */
function assignSeparatedComponents(
  components,
  modelGroup,
  result,
  candidateIndexById,
  freeGroups,
) {
  components.sort(
    (left, right) =>
      Math.min(...left.flatMap((item) => item.candidateIds)) -
      Math.min(...right.flatMap((item) => item.candidateIds)),
  );
  for (const [componentIndex, component] of components.entries()) {
    const group =
      componentIndex === 0
        ? modelGroup
        : /** @type {number} */ (freeGroups.shift());
    const candidateIds = component.flatMap((item) => item.candidateIds);
    for (const id of candidateIds) {
      const index = candidateIndexById.get(id);
      if (index !== undefined) result[index].group = group;
    }
  }
}

/**
 * @param {UpstreamFragment} fragment
 * @param {Map<number,ReviewCandidate>} candidateById
 */
function buildFragmentEvidence(fragment, candidateById) {
  const candidates = fragment.candidateIds.flatMap((id) => {
    const candidate = candidateById.get(id);
    return candidate ? [candidate] : [];
  });
  return {
    candidateIds: candidates.map((candidate) => candidate.id),
    bbox: unionBoxes(candidates.map((candidate) => candidate.bbox)),
    status: fragment.status,
    paddleGroups: new Set(
      candidates.flatMap((candidate) =>
        candidate.paddleGroup ? [candidate.paddleGroup] : [],
      ),
    ),
  };
}

/** @param {Array<ReturnType<typeof buildFragmentEvidence>>} evidence */
function collectPreservedFragmentComponents(evidence) {
  const parents = evidence.map((_, index) => index);
  /** @param {number} index */
  const root = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  /** @param {number} left @param {number} right */
  const join = (left, right) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < evidence.length; left += 1)
    for (let right = left + 1; right < evidence.length; right += 1)
      if (!isWeakDiagonalMerge(evidence[left], evidence[right]))
        join(left, right);
  /** @type {Map<number,Array<ReturnType<typeof buildFragmentEvidence>>>} */
  const components = new Map();
  evidence.forEach((item, index) => {
    const key = root(index);
    const members = components.get(key) ?? [];
    members.push(item);
    components.set(key, members);
  });
  return [...components.values()];
}

/**
 * @param {ReturnType<typeof buildFragmentEvidence>} left
 * @param {ReturnType<typeof buildFragmentEvidence>} right
 */
function isWeakDiagonalMerge(left, right) {
  const leftPaddle = [...left.paddleGroups][0];
  const rightPaddle = [...right.paddleGroups][0];
  if (!leftPaddle || !rightPaddle || leftPaddle === rightPaddle) return false;
  const intersection = boxIntersectionArea(left.bbox, right.bbox);
  const smallerCoverage =
    intersection /
    Math.max(1, Math.min(boxArea(left.bbox), boxArea(right.bbox)));
  return (
    intersection > 0 &&
    smallerCoverage <= 0.05 &&
    axisOverlapRatio(left.bbox, right.bbox, "x") < 0.5 &&
    axisOverlapRatio(left.bbox, right.bbox, "y") < 0.5
  );
}

/**
 * Stabilize model and fallback labels only for an unambiguous, low-confidence
 * small satellite that is at least 90% covered by its original Paddle host.
 *
 * @param {ReviewPlan} plan
 * @param {ReviewLabel[]} labels
 * @returns {ReviewLabel[]}
 */
function attachMostlyContainedRubyLabels(plan, labels) {
  const result = labels.map((label) => ({ ...label }));
  const candidateById = new Map(
    plan.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const candidateIndexById = new Map(
    plan.candidates.map((candidate, index) => [candidate.id, index]),
  );
  const fragmentMembers = new Map(
    plan.upstreamFragments.map((fragment) => [
      fragment.fragment,
      fragment.candidateIds.flatMap((id) => {
        const candidate = candidateById.get(id);
        return candidate ? [candidate] : [];
      }),
    ]),
  );
  for (const fragment of plan.upstreamFragments) {
    const members = fragmentMembers.get(fragment.fragment) ?? [];
    const satellite = readMostlyContainedRubySatellite(fragment, members);
    if (!satellite) continue;
    const hostMembers = findMostlyContainedRubyHost(
      plan.upstreamFragments,
      fragmentMembers,
      fragment,
      satellite,
    );
    if (!hostMembers) continue;
    const satelliteIndex = candidateIndexById.get(satellite.id);
    const hostIndex = candidateIndexById.get(hostMembers[0]?.id);
    if (satelliteIndex === undefined || hostIndex === undefined) continue;
    result[satelliteIndex] = {
      group: result[hostIndex].group,
      role: "ruby",
    };
  }
  attachDominantVerticalRubyClusterLabels(
    plan,
    result,
    candidateIndexById,
    fragmentMembers,
  );
  attachStrictLineageRubyLabels(plan, result, candidateIndexById);
  return attachDeferredRubyLabels(plan, result, candidateIndexById);
}

/**
 * @param {UpstreamFragment} fragment
 * @param {ReviewCandidate[]} members
 * @returns {ReviewCandidate|null}
 */
function readMostlyContainedRubySatellite(fragment, members) {
  if (members.length !== 1 || !isDeferredFragment(fragment, members))
    return null;
  const satellite = members[0];
  const reasons = Array.isArray(satellite.hint.reviewReasons)
    ? satellite.hint.reviewReasons.map(String)
    : [];
  return reasons.includes("small_low_confidence_text") &&
    satellite.paddleGroup &&
    satellite.score !== null &&
    satellite.score < 0.58
    ? satellite
    : null;
}

/**
 * @param {UpstreamFragment[]} fragments
 * @param {Map<string,ReviewCandidate[]>} fragmentMembers
 * @param {UpstreamFragment} sourceFragment
 * @param {ReviewCandidate} satellite
 * @returns {ReviewCandidate[]|null}
 */
function findMostlyContainedRubyHost(
  fragments,
  fragmentMembers,
  sourceFragment,
  satellite,
) {
  const hosts = [];
  for (const host of fragments) {
    const members = fragmentMembers.get(host.fragment) ?? [];
    if (
      host.fragment !== sourceFragment.fragment &&
      isEligibleMostlyContainedRubyHost(host, members, satellite)
    ) {
      hosts.push(members);
    }
  }
  return hosts.length === 1 ? hosts[0] : null;
}

/**
 * @param {UpstreamFragment} fragment
 * @param {ReviewCandidate[]} members
 * @param {ReviewCandidate} satellite
 */
function isEligibleMostlyContainedRubyHost(fragment, members, satellite) {
  if (
    !isConfirmedFragment(fragment, members) ||
    !members.some(
      (candidate) => candidate.paddleGroup === satellite.paddleGroup,
    )
  ) {
    return false;
  }
  const hostBox = unionBoxes(members.map((candidate) => candidate.bbox));
  const areaRatio = boxArea(satellite.bbox) / Math.max(1, boxArea(hostBox));
  const satelliteCoverage =
    boxIntersectionArea(hostBox, satellite.bbox) /
    Math.max(1, boxArea(satellite.bbox));
  return satelliteCoverage >= 0.9 && areaRatio <= 0.2;
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

module.exports = {
  attachMostlyContainedRubyLabels,
  separateWeakDiagonalFragmentMerges,
};
