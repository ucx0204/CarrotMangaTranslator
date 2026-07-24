// @ts-check

const {
  FORBIDDEN_DEFERRED_HOST_REASONS,
  GROUP_REVIEW_CROP_PLAN_VERSION,
} = require("./group-review-crop-contract.cjs");
const {
  alignedContextAxis,
  assertBoxInsidePage,
  boxIntersectionArea,
  boxOrientation,
  collectDisjointComponents,
  compareRegions,
  createDisjointSet,
  deferredHostScore,
  normalizeCandidateBox,
  normalizeOptionalPositiveInteger,
  normalizeOptionalString,
  normalizeReasons,
  requireInteger,
  requirePositiveInteger,
  unionBoxes,
} = require("./group-review-crop-geometry.cjs");
const {
  createPaddedRegion,
  resolveCropOverlaps,
} = require("./group-review-crop-regions.cjs");
const {
  assertGroupReviewCropPlan,
  serializeRegion,
} = require("./group-review-crop-serialization.cjs");

/** @typedef {import("./group-review-crop-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-review-crop-types").NormalizedCandidate} NormalizedCandidate */
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
    if (members.length > 1) reasons.push("confirmed_bbox_collision");
    if (ownedDeferred.length > 0) reasons.push("deferred_attached_once");
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

/**
 * @param {ReviewCandidate[]} candidates
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {NormalizedCandidate[]}
 */
function normalizeCandidates(candidates, pageWidth, pageHeight) {
  if (!Array.isArray(candidates)) {
    throw new Error("Group review candidates must be an array.");
  }
  const seenIds = new Set();
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Group review candidate ${index} is invalid.`);
    }
    const id = requireInteger(candidate.id, `candidate[${index}].id`);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate group review candidate id ${id}.`);
    }
    seenIds.add(id);
    const fragmentId = String(candidate.reviewFragmentId ?? "").trim();
    if (!fragmentId) {
      throw new Error(`candidate ${id} is missing reviewFragmentId.`);
    }
    const status = candidate.reviewStatus;
    if (status !== "confirmed" && status !== "deferred") {
      throw new Error(
        `candidate ${id} reviewStatus must be confirmed or deferred.`,
      );
    }
    const bbox = normalizeCandidateBox(candidate, id);
    assertBoxInsidePage(bbox, pageWidth, pageHeight, `candidate ${id}.bbox`);
    return {
      id,
      fragmentId,
      status,
      reasons: normalizeReasons(candidate.reviewReasons, id),
      order: requirePositiveInteger(
        candidate.reviewOrder,
        `candidate ${id}.reviewOrder`,
      ),
      bbox,
      paddleGroupId: normalizeOptionalString(candidate.paddleGroupId),
      paddleOrder: normalizeOptionalPositiveInteger(
        candidate.paddleOrder,
        `candidate ${id}.paddleOrder`,
      ),
      paddleGroupSize: normalizeOptionalPositiveInteger(
        candidate.paddleGroupSize,
        `candidate ${id}.paddleGroupSize`,
      ),
    };
  });
}

/** @param {NormalizedCandidate[]} candidates @returns {ReviewFragment[]} */
function buildFragments(candidates) {
  /** @type {Map<string,NormalizedCandidate[]>} */
  const byFragment = new Map();
  for (const candidate of candidates) {
    const members = byFragment.get(candidate.fragmentId) || [];
    members.push(candidate);
    byFragment.set(candidate.fragmentId, members);
  }
  const fragments = [...byFragment.entries()].map(([fragmentId, members]) => {
    const statuses = new Set(members.map((candidate) => candidate.status));
    if (statuses.size !== 1) {
      throw new Error(`Fragment ${fragmentId} has mixed reviewStatus values.`);
    }
    const orders = members.map((candidate) => candidate.order);
    if (new Set(orders).size !== orders.length) {
      throw new Error(
        `Fragment ${fragmentId} has duplicate reviewOrder values.`,
      );
    }
    members.sort(
      (left, right) => left.order - right.order || left.id - right.id,
    );
    return {
      fragmentId,
      status: members[0].status,
      reasons: [
        ...new Set(members.flatMap((candidate) => candidate.reasons)),
      ].sort(),
      candidates: members,
      bbox: unionBoxes(members.map((candidate) => candidate.bbox)),
    };
  });
  fragments.sort((left, right) =>
    left.fragmentId.localeCompare(right.fragmentId),
  );
  return fragments;
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
    if (matches.length === 0) continue;
    if (matches.length > 1 && matches[1].score <= matches[0].score + 0.2) {
      continue;
    }
    owners.set(fragment.fragmentId, matches[0].fragmentId);
  }
  return owners;
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
      if (boxIntersectionArea(left.bbox, right.bbox) > 0) {
        disjoint.union(left.fragmentId, right.fragmentId);
      }
    }
  }
  return collectDisjointComponents(fragments, disjoint);
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
