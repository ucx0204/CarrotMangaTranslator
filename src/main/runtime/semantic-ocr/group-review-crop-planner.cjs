// @ts-check

const {
  FORBIDDEN_DEFERRED_HOST_REASONS,
  GROUP_REVIEW_CROP_PLAN_VERSION,
} = require("./group-review-crop-contract.cjs");
const {
  alignedContextAxis,
  boxIntersectionArea,
  boxOrientation,
  collectDisjointComponents,
  compareRegions,
  createDisjointSet,
  deferredHostScore,
  requirePositiveInteger,
} = require("./group-review-crop-geometry.cjs");
const {
  buildFragments,
  normalizeCandidates,
} = require("./group-review-crop-candidates.cjs");
const {
  createPaddedRegion,
  resolveCropOverlaps,
} = require("./group-review-crop-regions.cjs");
const {
  assertGroupReviewCropPlan,
  serializeRegion,
} = require("./group-review-crop-serialization.cjs");
const {
  fragmentsHaveConservativeAnimeTextRelation,
} = require("./anime-text-review-relations.cjs");

/** @typedef {import("./group-review-crop-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-review-crop-types").ReviewFragment} ReviewFragment */
/** @typedef {import("./group-review-crop-types").InternalRegion} InternalRegion */

/**
 * @param {ReviewCandidate[]} candidates
 * @param {number} pageWidth
 * @param {number} pageHeight
 */
function buildGroupReviewCropPlan(candidates, pageWidth, pageHeight) {
  const width = requirePositiveInteger(pageWidth, "pageWidth");
  const height = requirePositiveInteger(pageHeight, "pageHeight");
  const normalized = normalizeCandidates(candidates, width, height);
  const fragments = buildFragments(normalized);
  validateReviewContexts(fragments);
  const confirmed = fragments.filter(
    (fragment) => fragment.status === "confirmed",
  );
  const deferred = fragments.filter(
    (fragment) => fragment.status === "deferred",
  );
  const contactMargin = Math.max(
    4,
    Math.round(Math.min(width, height) * 0.006),
  );
  const deferredOwner = attachDeferredToConfirmed(
    confirmed,
    deferred,
    contactMargin,
  );
  let regions = buildConfirmedRegions(
    confirmed,
    deferred,
    deferredOwner,
    width,
    height,
  );
  appendHostlessDeferredRegions(
    regions,
    deferred,
    deferredOwner,
    width,
    height,
    contactMargin,
  );
  regions = resolveCropOverlaps(regions);
  regions.sort(compareRegions);
  const publicRegions = regions.map((region, index) =>
    serializeRegion(region, index + 1),
  );
  const plan = {
    version: GROUP_REVIEW_CROP_PLAN_VERSION,
    pageWidth: width,
    pageHeight: height,
    fragmentCount: fragments.length,
    candidateCount: normalized.length,
    regions: publicRegions,
  };
  assertGroupReviewCropPlan(plan, fragments);
  return plan;
}

/**
 * @param {ReviewFragment[]} confirmed
 * @param {ReviewFragment[]} deferred
 * @param {Map<string,string>} deferredOwner
 * @param {number} width
 * @param {number} height
 */
function buildConfirmedRegions(
  confirmed,
  deferred,
  deferredOwner,
  width,
  height,
) {
  return collectOverlappingConfirmed(confirmed).map((members) => {
    const confirmedIds = new Set(
      members.map((fragment) => fragment.fragmentId),
    );
    const ownedDeferred = deferred.filter((fragment) =>
      confirmedIds.has(deferredOwner.get(fragment.fragmentId) || ""),
    );
    const reasons = [];
    if (hasConfirmedBboxCollision(members)) {
      reasons.push("confirmed_bbox_collision");
    }
    if (hasSharedReviewContext(members)) {
      reasons.push("confirmed_review_context");
    }
    if (ownedDeferred.length > 0) reasons.push("deferred_attached_once");
    if (hasSharedAnimeTextEvidence(members, ownedDeferred)) {
      reasons.push("deferred_anime_text_hint");
    }
    return createPaddedRegion(
      [...members, ...ownedDeferred],
      reasons,
      width,
      height,
    );
  });
}

/**
 * @param {InternalRegion[]} regions
 * @param {ReviewFragment[]} deferred
 * @param {Map<string,string>} deferredOwner
 * @param {number} width
 * @param {number} height
 * @param {number} contactMargin
 */
function appendHostlessDeferredRegions(
  regions,
  deferred,
  deferredOwner,
  width,
  height,
  contactMargin,
) {
  const hostless = deferred.filter(
    (fragment) => !deferredOwner.has(fragment.fragmentId),
  );
  const margin = Math.max(
    contactMargin,
    Math.round(Math.min(width, height) * 0.018),
  );
  for (const members of collectAxisAlignedDeferred(hostless, margin)) {
    regions.push(
      createPaddedRegion(
        members,
        [members.length > 1 ? "deferred_axis_context" : "deferred_only"],
        width,
        height,
      ),
    );
  }
}

/** @param {ReviewFragment[]} fragments */
function validateReviewContexts(fragments) {
  /** @type {Map<string, ReviewFragment[]>} */
  const contexts = new Map();
  for (const fragment of fragments) {
    if (!fragment.reviewContextId) continue;
    const members = contexts.get(fragment.reviewContextId) || [];
    members.push(fragment);
    contexts.set(fragment.reviewContextId, members);
  }
  for (const [contextId, members] of contexts) {
    if (members.length < 2) {
      throw new Error(
        `reviewContextId ${contextId} must connect at least two review fragments.`,
      );
    }
  }
}

/** @param {ReviewFragment[]} confirmed @param {ReviewFragment[]} deferred @param {number} contactMargin */
function attachDeferredToConfirmed(confirmed, deferred, contactMargin) {
  const owners = new Map();
  for (const fragment of deferred) {
    if (
      fragment.reasons.some((reason) =>
        FORBIDDEN_DEFERRED_HOST_REASONS.has(reason),
      )
    ) {
      continue;
    }
    const matches = confirmed
      .flatMap((host) => {
        const score = deferredHostScore(
          host.bbox,
          fragment.bbox,
          contactMargin,
        );
        return score === null ? [] : [{ score, fragmentId: host.fragmentId }];
      })
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.fragmentId.localeCompare(right.fragmentId),
      );
    if (
      matches.length > 0 &&
      (matches.length === 1 || matches[1].score > matches[0].score + 0.2)
    ) {
      owners.set(fragment.fragmentId, matches[0].fragmentId);
      continue;
    }
    const detectorMatches = confirmed.filter((host) =>
      fragmentsShareAnimeTextRegion(host, fragment),
    );
    if (detectorMatches.length === 1) {
      owners.set(fragment.fragmentId, detectorMatches[0].fragmentId);
    }
  }
  return owners;
}

/** @param {ReviewFragment[]} confirmed @param {ReviewFragment[]} deferred */
function hasSharedAnimeTextEvidence(confirmed, deferred) {
  return deferred.some((deferredFragment) =>
    confirmed.some((confirmedFragment) =>
      fragmentsShareAnimeTextRegion(confirmedFragment, deferredFragment),
    ),
  );
}

/** @param {ReviewFragment} left @param {ReviewFragment} right */
function fragmentsShareAnimeTextRegion(left, right) {
  const leftIds = new Set(
    left.candidates
      .map((candidate) => candidate.animeTextRegionId)
      .filter(Boolean),
  );
  const sharesRegion = right.candidates.some(
    (candidate) =>
      candidate.animeTextRegionId && leftIds.has(candidate.animeTextRegionId),
  );
  return (
    sharesRegion && fragmentsHaveConservativeAnimeTextRelation(left, right)
  );
}

/** @param {ReviewFragment[]} fragments @returns {ReviewFragment[][]} */
function collectOverlappingConfirmed(fragments) {
  const disjoint = createDisjointSet(fragments.map((item) => item.fragmentId));
  for (let leftIndex = 0; leftIndex < fragments.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < fragments.length;
      rightIndex += 1
    ) {
      const left = fragments[leftIndex];
      const right = fragments[rightIndex];
      if (
        boxIntersectionArea(left.bbox, right.bbox) > 0 ||
        (left.reviewContextId && left.reviewContextId === right.reviewContextId)
      ) {
        disjoint.union(left.fragmentId, right.fragmentId);
      }
    }
  }
  return collectDisjointComponents(fragments, disjoint);
}

/** @param {ReviewFragment[]} fragments */
function hasConfirmedBboxCollision(fragments) {
  for (let leftIndex = 0; leftIndex < fragments.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < fragments.length;
      rightIndex += 1
    ) {
      if (
        boxIntersectionArea(
          fragments[leftIndex].bbox,
          fragments[rightIndex].bbox,
        ) > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

/** @param {ReviewFragment[]} fragments */
function hasSharedReviewContext(fragments) {
  const counts = new Map();
  for (const fragment of fragments) {
    const contextId = fragment.reviewContextId;
    if (!contextId) continue;
    const count = (counts.get(contextId) || 0) + 1;
    if (count >= 2) return true;
    counts.set(contextId, count);
  }
  return false;
}

/** @param {ReviewFragment[]} fragments @param {number} margin @returns {ReviewFragment[][]} */
function collectAxisAlignedDeferred(fragments, margin) {
  const disjoint = createDisjointSet(fragments.map((item) => item.fragmentId));
  for (let leftIndex = 0; leftIndex < fragments.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < fragments.length;
      rightIndex += 1
    ) {
      const left = fragments[leftIndex];
      const right = fragments[rightIndex];
      if (!alignedContextAxis(left.bbox, right.bbox, margin)) continue;
      const leftOrientation = boxOrientation(left.bbox);
      const rightOrientation = boxOrientation(right.bbox);
      if (
        leftOrientation !== rightOrientation &&
        leftOrientation !== "ambiguous" &&
        rightOrientation !== "ambiguous"
      ) {
        continue;
      }
      disjoint.union(left.fragmentId, right.fragmentId);
    }
  }
  return collectDisjointComponents(fragments, disjoint);
}

module.exports = { buildGroupReviewCropPlan };
