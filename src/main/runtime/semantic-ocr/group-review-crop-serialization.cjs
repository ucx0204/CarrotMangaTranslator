// @ts-check

const {
  GROUP_REVIEW_CROP_PLAN_VERSION,
} = require("./group-review-crop-contract.cjs");
const {
  assertBbox1000,
  assertBoxInsidePage,
  boxContains,
  boxIntersectionArea,
  pageBoxToCropRect,
  projectBoxToCrop1000,
  sameArray,
  sameBox,
  unionBoxes,
} = require("./group-review-crop-geometry.cjs");

/** @typedef {import("./group-review-crop-types").ReviewFragment} ReviewFragment */
/** @typedef {import("./group-review-crop-types").InternalRegion} InternalRegion */
/** @typedef {import("./group-review-crop-types").CropCandidate} CropCandidate */
/** @typedef {import("./group-review-crop-types").CropFragment} CropFragment */
/** @typedef {import("./group-review-crop-types").GroupReviewCropRegion} GroupReviewCropRegion */
/** @typedef {import("./group-review-crop-types").GroupReviewCropPlan} GroupReviewCropPlan */

/**
 * @param {InternalRegion} region
 * @param {number} cropNumber
 */
function serializeRegion(region, cropNumber) {
  const fragments = region.fragments.map((fragment) => ({
    reviewFragmentId: fragment.fragmentId,
    reviewStatus: fragment.status,
    reviewReasons: [...fragment.reasons],
    candidateIds: fragment.candidates.map((candidate) => candidate.id),
    bbox: { ...fragment.bbox },
    bbox1000: projectBoxToCrop1000(fragment.bbox, region.cropBbox),
  }));
  const candidates = region.fragments
    .flatMap((fragment) =>
      fragment.candidates.map((candidate) => ({
        candidateId: candidate.id,
        reviewFragmentId: fragment.fragmentId,
        reviewStatus: fragment.status,
        reviewOrder: candidate.order,
        paddleGroupId: candidate.paddleGroupId,
        paddleOrder: candidate.paddleOrder,
        paddleGroupSize: candidate.paddleGroupSize,
        bbox: { ...candidate.bbox },
        bbox1000: projectBoxToCrop1000(candidate.bbox, region.cropBbox),
      })),
    )
    .sort(
      (left, right) =>
        left.reviewFragmentId.localeCompare(right.reviewFragmentId) ||
        left.reviewOrder - right.reviewOrder ||
        left.candidateId - right.candidateId,
    );
  const confirmedFragmentIds = fragments
    .filter((fragment) => fragment.reviewStatus === "confirmed")
    .map((fragment) => fragment.reviewFragmentId);
  const deferredFragmentIds = fragments
    .filter((fragment) => fragment.reviewStatus === "deferred")
    .map((fragment) => fragment.reviewFragmentId);
  const cropBbox = { ...region.cropBbox };
  return {
    cropId: `C${String(cropNumber).padStart(3, "0")}`,
    reasons: [...region.reasons],
    confirmedFragmentIds,
    deferredFragmentIds,
    fragmentIds: fragments.map((fragment) => fragment.reviewFragmentId),
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    fragments,
    candidates,
    contentBbox: { ...region.contentBbox },
    cropBbox,
    cropRect: pageBoxToCropRect(cropBbox),
    padding: { ...region.padding },
  };
}

/** @param {GroupReviewCropPlan} plan @param {ReviewFragment[]} [sourceFragments] */
function assertGroupReviewCropPlan(plan, sourceFragments) {
  assertPlanShape(plan);
  const fragmentIds = plan.regions.flatMap((region) => region.fragmentIds);
  const candidateIds = plan.regions.flatMap((region) => region.candidateIds);
  assertPartitionCounts(plan, fragmentIds, candidateIds);
  if (sourceFragments) {
    assertSourceCoverage(sourceFragments, fragmentIds, candidateIds);
  }
  for (const region of plan.regions) {
    assertRegion(plan, region);
  }
  assertNonOverlappingRegions(plan.regions);
}

/** @param {GroupReviewCropPlan} plan */
function assertPlanShape(plan) {
  if (
    !plan ||
    plan.version !== GROUP_REVIEW_CROP_PLAN_VERSION ||
    !Number.isInteger(plan.pageWidth) ||
    !Number.isInteger(plan.pageHeight) ||
    plan.pageWidth <= 0 ||
    plan.pageHeight <= 0 ||
    !Array.isArray(plan.regions)
  ) {
    throw new Error("Invalid group review crop plan.");
  }
}

/**
 * @param {GroupReviewCropPlan} plan
 * @param {string[]} fragmentIds
 * @param {number[]} candidateIds
 */
function assertPartitionCounts(plan, fragmentIds, candidateIds) {
  if (
    new Set(fragmentIds).size !== fragmentIds.length ||
    fragmentIds.length !== plan.fragmentCount
  ) {
    throw new Error("Review fragments are not a one-to-one crop partition.");
  }
  if (
    new Set(candidateIds).size !== candidateIds.length ||
    candidateIds.length !== plan.candidateCount
  ) {
    throw new Error("Review candidates are not a one-to-one crop partition.");
  }
}

/**
 * @param {ReviewFragment[]} sourceFragments
 * @param {string[]} fragmentIds
 * @param {number[]} candidateIds
 */
function assertSourceCoverage(sourceFragments, fragmentIds, candidateIds) {
  const expectedFragments = sourceFragments
    .map((fragment) => fragment.fragmentId)
    .sort();
  const expectedCandidates = sourceFragments
    .flatMap((fragment) => fragment.candidates.map((candidate) => candidate.id))
    .sort((left, right) => left - right);
  if (!sameArray([...fragmentIds].sort(), expectedFragments)) {
    throw new Error("Review fragment coverage changed while planning crops.");
  }
  if (
    !sameArray(
      [...candidateIds].sort((left, right) => left - right),
      expectedCandidates,
    )
  ) {
    throw new Error("Review candidate coverage changed while planning crops.");
  }
}

/** @param {GroupReviewCropPlan} plan @param {GroupReviewCropRegion} region */
function assertRegion(plan, region) {
  const trimAllowed = region.reasons.some(
    (reason) =>
      reason === "narrow_content_seam" || reason === "display_priority_clip",
  );
  assertBoxInsidePage(
    region.contentBbox,
    plan.pageWidth,
    plan.pageHeight,
    `${region.cropId}.contentBbox`,
  );
  assertBoxInsidePage(
    region.cropBbox,
    plan.pageWidth,
    plan.pageHeight,
    `${region.cropId}.cropBbox`,
  );
  if (!trimAllowed && !boxContains(region.cropBbox, region.contentBbox)) {
    throw new Error(`${region.cropId} trims review content.`);
  }
  assertExactRegionUnion(region);
  assertFragmentCandidateCoverage(region);
  for (const candidate of region.candidates) {
    assertCandidate(region, candidate, trimAllowed);
  }
  for (const fragment of region.fragments) {
    assertFragment(region, fragment);
  }
}

/** @param {GroupReviewCropRegion} region */
function assertExactRegionUnion(region) {
  const exactContent = unionBoxes(
    region.candidates.map((candidate) => candidate.bbox),
  );
  if (!sameBox(exactContent, region.contentBbox)) {
    throw new Error(`${region.cropId} content bbox is not an exact union.`);
  }
}

/** @param {GroupReviewCropRegion} region */
function assertFragmentCandidateCoverage(region) {
  const fragmentCandidateIds = region.fragments.flatMap(
    (fragment) => fragment.candidateIds,
  );
  if (
    !sameArray(
      [...fragmentCandidateIds].sort((left, right) => left - right),
      [...region.candidateIds].sort((left, right) => left - right),
    )
  ) {
    throw new Error(`${region.cropId} fragment candidate coverage changed.`);
  }
}

/**
 * @param {GroupReviewCropRegion} region
 * @param {CropCandidate} candidate
 * @param {boolean} trimAllowed
 */
function assertCandidate(region, candidate, trimAllowed) {
  if (
    !boxContains(region.cropBbox, candidate.bbox) &&
    (!trimAllowed || boxIntersectionArea(region.cropBbox, candidate.bbox) <= 0)
  ) {
    throw new Error(
      `${region.cropId} trims candidate ${candidate.candidateId}.`,
    );
  }
  assertBbox1000(candidate.bbox1000, `${region.cropId}.candidate`);
}

/** @param {GroupReviewCropRegion} region @param {CropFragment} fragment */
function assertFragment(region, fragment) {
  const members = region.candidates.filter(
    (candidate) => candidate.reviewFragmentId === fragment.reviewFragmentId,
  );
  if (
    !sameBox(
      unionBoxes(members.map((candidate) => candidate.bbox)),
      fragment.bbox,
    )
  ) {
    throw new Error(
      `${region.cropId} fragment ${fragment.reviewFragmentId} is not an exact union.`,
    );
  }
  assertBbox1000(fragment.bbox1000, `${region.cropId}.fragment`);
}

/** @param {GroupReviewCropRegion[]} regions */
function assertNonOverlappingRegions(regions) {
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < regions.length;
      rightIndex += 1
    ) {
      if (
        boxIntersectionArea(
          regions[leftIndex].cropBbox,
          regions[rightIndex].cropBbox,
        ) > 0
      ) {
        throw new Error("Final group review crop rectangles overlap.");
      }
    }
  }
}

module.exports = { assertGroupReviewCropPlan, serializeRegion };
