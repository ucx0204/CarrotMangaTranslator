// @ts-check

const {
  FORBIDDEN_DEFERRED_HOST_REASONS,
} = require("./group-review-crop-contract.cjs");
const {
  tryReadAnimeTextEvidence: tryReadCanonicalAnimeTextEvidence,
} = require("../ocr/anime-text-evidence-contract.cjs");
const {
  buildDistinctAnimeTextRegionBarriers,
  hasPotentialDistinctAnimeTextRelation,
  qualifyDistinctAnimeTextRelationRegionIds,
} = require("./anime-text-distinct-region-barriers.cjs");
const {
  buildPaddleClassifierRecoveryRelations,
} = require("./paddle-classifier-recovery.cjs");

/**
 * @typedef {{
 *   id?:unknown;
 *   x1?:unknown;
 *   y1?:unknown;
 *   x2?:unknown;
 *   y2?:unknown;
 *   bbox?:unknown;
 *   reviewFragmentId?:unknown;
 *   reviewStatus?:unknown;
 *   reviewReasons?:unknown;
 *   animeTextRegionId?:unknown;
 *   animeTextRegionScore?:unknown;
 *   animeTextContainment?:unknown;
 *   animeTextRegionBbox?:unknown;
 *   animeTextEvidenceVersion?:unknown;
 *   animeTextModelRevision?:unknown;
 * }} CandidateLike
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} Box
 * @typedef {{
 *   regionId:string;
 *   score:number;
 *   containment:number;
 *   bboxPixels:number[];
 * }} AnimeTextEvidence
 * @typedef {{
 *   fragmentId:string;
 *   status:"confirmed"|"deferred";
 *   candidates:CandidateLike[];
 *   bbox:Box;
 *   reasons?:unknown;
 * }} ReviewFragment
 * @typedef {{
 *   writingMode:"vertical"|"horizontal";
 *   startDeltaPx:number;
 *   crossGapPx:number;
 *   tolerancePx:number;
 * }} ConservativeAlignment
 * @typedef {{
 *   regionId:string;
 *   members:CandidateLike[];
 *   evidence:AnimeTextEvidence[];
 *   confirmed:ReviewFragment;
 *   deferred:ReviewFragment;
 *   alignment:ConservativeAlignment;
 *   bboxPixels:number[];
 * }} QualifiedAnimeTextRegion
 */

/**
 * Return only regions that are safe to use as an auxiliary relation after
 * inspecting the complete page candidate set. A region is qualified only when
 * it contains exactly one complete confirmed fragment and one complete
 * deferred fragment. Callers must pass the full page, never a crop subset.
 *
 * @param {unknown[]} pageCandidates
 * @returns {string[]}
 */
function qualifyAnimeTextRelationRegionIds(pageCandidates) {
  return [
    ...new Set([
      ...qualifySharedAnimeTextRelationRegionIds(pageCandidates),
      ...qualifyDistinctAnimeTextRelationRegionIds(pageCandidates),
    ]),
  ];
}

/** @param {unknown[]} pageCandidates */
function qualifySharedAnimeTextRelationRegionIds(pageCandidates) {
  return collectQualifiedAnimeTextRegions(pageCandidates).map(
    (region) => region.regionId,
  );
}

/**
 * anime-text-yolo has no balloon-boundary knowledge, so a shared detector box
 * is not enough to create a review relation. Emit one only after the page-wide
 * completeness check and an independent, scale-relative alignment gate.
 *
 * @param {unknown[]} pageCandidates
 */
function buildAnimeTextSpatialRelations(pageCandidates) {
  const distinctAnimeTextRegionBarriers =
    buildDistinctAnimeTextRegionBarriers(pageCandidates);
  const paddleClassifierRecoveries =
    buildPaddleClassifierRecoveryRelations(pageCandidates);
  return {
    sharedAnimeTextRegions:
      collectQualifiedAnimeTextRegions(pageCandidates).map(toSpatialRelation),
    ...(distinctAnimeTextRegionBarriers.length > 0
      ? { distinctAnimeTextRegionBarriers }
      : {}),
    ...(paddleClassifierRecoveries.length > 0
      ? { paddleClassifierRecoveries }
      : {}),
  };
}

/**
 * This is deliberately page-wide. Fragment completeness cannot be established
 * from a review crop because another fragment member may be outside that crop.
 *
 * @param {unknown[]} pageCandidates
 * @returns {QualifiedAnimeTextRegion[]}
 */
function collectQualifiedAnimeTextRegions(pageCandidates) {
  if (!Array.isArray(pageCandidates)) return [];
  const records = pageCandidates.filter(isJsonRecord);
  const pageFragments = indexPageFragments(records);
  const regions = indexAnimeTextRegions(records);
  /** @type {QualifiedAnimeTextRegion[]} */
  const qualified = [];
  for (const [regionId, members] of regions) {
    const evidence = validateSharedRegionEvidence(regionId, members);
    if (!evidence) continue;
    const fragments = buildReviewFragments(members);
    if (fragments.length !== 2) continue;
    const confirmed = fragments.filter(
      (fragment) => fragment.status === "confirmed",
    );
    const deferred = fragments.filter(
      (fragment) => fragment.status === "deferred",
    );
    if (confirmed.length !== 1 || deferred.length !== 1) continue;
    if (
      !isCompleteFragment(confirmed[0], regionId, pageFragments) ||
      !isCompleteFragment(deferred[0], regionId, pageFragments)
    ) {
      continue;
    }
    const alignment = readConservativePairAlignment(confirmed[0], deferred[0]);
    if (!alignment) continue;
    qualified.push({
      regionId,
      members,
      evidence,
      confirmed: confirmed[0],
      deferred: deferred[0],
      alignment,
      bboxPixels: evidence[0].bboxPixels,
    });
  }
  return qualified;
}

/** @param {QualifiedAnimeTextRegion} region */
function toSpatialRelation(region) {
  return {
    kind: "shared_anime_text_region",
    strength: "auxiliary_review_hint",
    basis: "detector_plus_aligned_reading_start",
    recommendedAction: "merge_unless_visible_separator",
    regionId: region.regionId,
    candidateIds: region.members.map((candidate) => candidate.id),
    confirmedFragment: {
      fragmentId: region.confirmed.fragmentId,
      candidateIds: region.confirmed.candidates.map(
        (candidate) => candidate.id,
      ),
    },
    deferredFragment: {
      fragmentId: region.deferred.fragmentId,
      candidateIds: region.deferred.candidates.map((candidate) => candidate.id),
    },
    alignment: region.alignment,
    score: Math.min(...region.evidence.map((item) => item.score)),
    bboxPixels: region.bboxPixels,
    candidateCoverage: region.members.map((candidate, index) => ({
      id: candidate.id,
      coverage: region.evidence[index].containment,
    })),
  };
}

/** @param {CandidateLike[]} candidates */
function hasPotentialAnimeTextRelation(candidates) {
  return (
    hasPotentialSharedAnimeTextRelation(candidates) ||
    hasPotentialDistinctAnimeTextRelation(candidates)
  );
}

/** @param {CandidateLike[]} candidates */
function hasPotentialSharedAnimeTextRelation(candidates) {
  const fragments = buildReviewFragments(candidates);
  const confirmed = fragments.filter(
    (fragment) => fragment.status === "confirmed",
  );
  const deferred = fragments.filter(
    (fragment) => fragment.status === "deferred",
  );
  return deferred.some((deferredFragment) =>
    confirmed.some((confirmedFragment) =>
      Boolean(
        readConservativePairAlignment(confirmedFragment, deferredFragment),
      ),
    ),
  );
}

/**
 * @param {ReviewFragment} left
 * @param {ReviewFragment} right
 */
function fragmentsHaveConservativeAnimeTextRelation(left, right) {
  return Boolean(readConservativePairAlignment(left, right));
}

/** @param {CandidateLike[]} candidates @returns {Map<string,CandidateLike[]>} */
function indexPageFragments(candidates) {
  /** @type {Map<string,CandidateLike[]>} */
  const fragments = new Map();
  for (const candidate of candidates) {
    const fragmentId = String(candidate.reviewFragmentId ?? "").trim();
    if (!fragmentId) continue;
    const members = fragments.get(fragmentId) || [];
    members.push(candidate);
    fragments.set(fragmentId, members);
  }
  return fragments;
}

/** @param {CandidateLike[]} candidates @returns {Map<string,CandidateLike[]>} */
function indexAnimeTextRegions(candidates) {
  /** @type {Map<string,CandidateLike[]>} */
  const regions = new Map();
  for (const candidate of candidates) {
    const regionId = readRegionId(candidate.animeTextRegionId);
    if (!regionId) continue;
    const members = regions.get(regionId) || [];
    members.push(candidate);
    regions.set(regionId, members);
  }
  return regions;
}

/**
 * @param {ReviewFragment} fragment
 * @param {string} regionId
 * @param {Map<string,CandidateLike[]>} pageFragments
 */
function isCompleteFragment(fragment, regionId, pageFragments) {
  const pageMembers = pageFragments.get(fragment.fragmentId);
  if (!pageMembers || pageMembers.length !== fragment.candidates.length) {
    return false;
  }
  return pageMembers.every((candidate) => {
    const evidence = readAnimeTextEvidence(candidate);
    return evidence?.regionId === regionId;
  });
}

/**
 * @param {string} regionId
 * @param {CandidateLike[]} members
 * @returns {AnimeTextEvidence[]|null}
 */
function validateSharedRegionEvidence(regionId, members) {
  /** @type {AnimeTextEvidence[]} */
  const result = [];
  let reference = null;
  for (const candidate of members) {
    const evidence = readAnimeTextEvidence(candidate);
    if (!evidence || evidence.regionId !== regionId) return null;
    if (
      reference &&
      (evidence.score !== reference.score ||
        !sameBox(evidence.bboxPixels, reference.bboxPixels))
    ) {
      return null;
    }
    reference = reference || evidence;
    result.push(evidence);
  }
  return result.length > 0 ? result : null;
}

/** @param {CandidateLike} candidate @returns {AnimeTextEvidence|null} */
function readAnimeTextEvidence(candidate) {
  const evidence = tryReadCanonicalAnimeTextEvidence(
    candidate,
    `candidate ${String(candidate.id ?? "?")}`,
  );
  return evidence
    ? {
        regionId: evidence.animeTextRegionId,
        score: evidence.animeTextRegionScore,
        containment: evidence.animeTextContainment,
        bboxPixels: evidence.animeTextRegionBbox,
      }
    : null;
}

/** @param {unknown} value */
function readRegionId(value) {
  const regionId = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^ATY\d{3,4}$/.test(regionId) ? regionId : null;
}

/** @param {number[]} left @param {number[]} right */
function sameBox(left, right) {
  return left.every((value, index) => value === right[index]);
}

/** @param {unknown} value @returns {value is CandidateLike} */
function isJsonRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {CandidateLike[]} candidates @returns {ReviewFragment[]} */
function buildReviewFragments(candidates) {
  /** @type {Map<string,ReviewFragment>} */
  const fragments = new Map();
  for (const candidate of candidates) {
    const fragmentId = String(candidate.reviewFragmentId ?? "").trim();
    const status = candidate.reviewStatus;
    const bbox = readBox(candidate);
    if (
      !fragmentId ||
      (status !== "confirmed" && status !== "deferred") ||
      !bbox
    ) {
      return [];
    }
    const fragment = fragments.get(fragmentId);
    if (fragment) {
      if (fragment.status !== status) return [];
      fragment.candidates.push(candidate);
      fragment.bbox = unionBoxes(fragment.bbox, bbox);
    } else {
      fragments.set(fragmentId, {
        fragmentId,
        status,
        candidates: [candidate],
        bbox,
      });
    }
  }
  return [...fragments.values()];
}

/**
 * @param {ReviewFragment} left
 * @param {ReviewFragment} right
 * @returns {ConservativeAlignment|null}
 */
function readConservativePairAlignment(left, right) {
  const confirmed = findFragmentByStatus(left, right, "confirmed");
  const deferred = findFragmentByStatus(left, right, "deferred");
  if (!confirmed || !deferred || hasForbiddenDeferredReason(deferred)) {
    return null;
  }
  const boxes = [...confirmed.candidates, ...deferred.candidates]
    .map(readBox)
    .filter((box) => box !== null);
  const verticalCount = boxes.filter(isVerticalBox).length;
  const horizontalCount = boxes.filter(isHorizontalBox).length;
  if (verticalCount === horizontalCount) return null;
  const characterScale = median(
    boxes
      .map((box) => Math.min(box.x2 - box.x1, box.y2 - box.y1))
      .sort((leftValue, rightValue) => leftValue - rightValue),
  );
  const tolerancePx = Math.max(8, characterScale * 0.8);
  const vertical = verticalCount > horizontalCount;
  const startDeltaPx = readingStartDelta(
    confirmed.bbox,
    deferred.bbox,
    vertical,
  );
  const crossGapPx = crossAxisGap(confirmed.bbox, deferred.bbox, vertical);
  if (startDeltaPx > tolerancePx || crossGapPx > tolerancePx) return null;
  return {
    writingMode: vertical ? "vertical" : "horizontal",
    startDeltaPx: roundCoordinate(startDeltaPx),
    crossGapPx: roundCoordinate(crossGapPx),
    tolerancePx: roundCoordinate(tolerancePx),
  };
}

/**
 * @param {ReviewFragment} left
 * @param {ReviewFragment} right
 * @param {"confirmed"|"deferred"} status
 */
function findFragmentByStatus(left, right, status) {
  if (left.status === status) return left;
  return right.status === status ? right : null;
}

/** @param {Box} left @param {Box} right @param {boolean} vertical */
function readingStartDelta(left, right, vertical) {
  return vertical ? Math.abs(left.y1 - right.y1) : Math.abs(left.x1 - right.x1);
}

/** @param {Box} left @param {Box} right @param {boolean} vertical */
function crossAxisGap(left, right, vertical) {
  return axisGap(left, right, vertical ? "x" : "y");
}

/** @param {ReviewFragment} fragment */
function hasForbiddenDeferredReason(fragment) {
  return (
    reasonsAreForbidden(fragment.reasons) ||
    fragment.candidates.some((candidate) =>
      reasonsAreForbidden(candidate.reviewReasons),
    )
  );
}

/** @param {unknown} value */
function reasonsAreForbidden(value) {
  if (value === undefined) return false;
  if (!Array.isArray(value)) return true;
  return value.some((reason) =>
    FORBIDDEN_DEFERRED_HOST_REASONS.has(String(reason)),
  );
}

/** @param {CandidateLike} candidate @returns {Box|null} */
function readBox(candidate) {
  const nested = isJsonRecord(candidate.bbox) ? candidate.bbox : null;
  const [x1, y1, x2, y2] = nested
    ? [nested.x1, nested.y1, nested.x2, nested.y2]
    : [candidate.x1, candidate.y1, candidate.x2, candidate.y2];
  const box = {
    x1: Number(x1),
    y1: Number(y1),
    x2: Number(x2),
    y2: Number(y2),
  };
  return Object.values(box).every(Number.isFinite) &&
    box.x2 > box.x1 &&
    box.y2 > box.y1
    ? box
    : null;
}

/** @param {Box} left @param {Box} right */
function unionBoxes(left, right) {
  return {
    x1: Math.min(left.x1, right.x1),
    y1: Math.min(left.y1, right.y1),
    x2: Math.max(left.x2, right.x2),
    y2: Math.max(left.y2, right.y2),
  };
}

/** @param {Box} box */
function isVerticalBox(box) {
  return box.y2 - box.y1 >= (box.x2 - box.x1) * 1.2;
}

/** @param {Box} box */
function isHorizontalBox(box) {
  return box.x2 - box.x1 >= (box.y2 - box.y1) * 1.2;
}

/** @param {Box} left @param {Box} right @param {"x"|"y"} axis */
function axisGap(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return Math.max(
    0,
    Math.max(left[start], right[start]) - Math.min(left[end], right[end]),
  );
}

/** @param {number[]} sorted */
function median(sorted) {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** @param {number} value */
function roundCoordinate(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  buildAnimeTextSpatialRelations,
  fragmentsHaveConservativeAnimeTextRelation,
  hasPotentialAnimeTextRelation,
  hasPotentialSharedAnimeTextRelation,
  qualifyAnimeTextRelationRegionIds,
  qualifySharedAnimeTextRelationRegionIds,
};
