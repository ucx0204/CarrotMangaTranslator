// @ts-check

const {
  tryReadAnimeTextEvidence: tryReadCanonicalAnimeTextEvidence,
} = require("../ocr/anime-text-evidence-contract.cjs");
const {
  smallerBoxOverlapRatio,
} = require("./anime-text-distinct-region-geometry.cjs");

const MIN_REGION_SCORE = 0.8;
const MIN_CONTAINMENT = 0.9;
const MIN_READING_BAND_REGION_SCORE = 0.65;
const MIN_READING_BAND_CONTAINMENT = 0.88;
const MAX_SMALLER_REGION_OVERLAP = 0.05;

/**
 * @typedef {Record<string,unknown>} Candidate
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} Box
 * @typedef {{
 *   regionId:string;
 *   score:number;
 *   containment:number;
 *   bboxPixels:number[];
 * }} Evidence
 * @typedef {{
 *   fragmentId:string;
 *   status:"confirmed"|"deferred";
 *   candidates:Candidate[];
 *   bbox:Box;
 *   sourceFragmentId?:string;
 *   syntheticFragmentId?:string;
 *   paddleGroupId?:string;
 *   partitionKey?:string;
 * }} Fragment
 * @typedef {{
 *   writingMode:"vertical"|"horizontal";
 *   characterScale:number;
 *   startDeltaPx:number;
 *   crossGapPx:number;
 *   readingGapPx:number;
 * }} PairGeometry
 * @typedef {{
 *   reviewContextId:string|null;
 *   paddleGroupId:string|null;
 *   sourceFragmentId:string|null;
 *   internalPartitionKind:"paddle_groups"|"reading_start_bands"|null;
 *   fragments:[Fragment,Fragment];
 *   geometry:PairGeometry;
 * }} PotentialBarrier
 * @typedef {{
 *   fragment:Fragment;
 *   regionId:string;
 *   evidence:Evidence[];
 *   bboxPixels:number[];
 * }} QualifiedFragment
 * @typedef {{
 *   reviewContextId:string|null;
 *   paddleGroupId:string|null;
 *   sourceFragmentId:string|null;
 *   internalPartitionKind:"paddle_groups"|"reading_start_bands"|null;
 *   fragments:[QualifiedFragment,QualifiedFragment];
 *   geometry:PairGeometry;
 *   smallerRegionOverlap:number;
 * }} QualifiedBarrier
 */

/**
 * @param {Candidate[]} pageCandidates
 * @param {PotentialBarrier[]} potentialBarriers
 * @returns {QualifiedBarrier[]}
 */
function qualifyPotentialBarriers(pageCandidates, potentialBarriers) {
  const pageFragments = indexPageFragments(pageCandidates);
  const regions = indexRegions(pageCandidates);
  return potentialBarriers
    .map((pair) => qualifyPair(pair, pageFragments, regions))
    .filter((pair) => pair !== null);
}

/**
 * @param {PotentialBarrier} pair
 * @param {Map<string,Candidate[]>} pageFragments
 * @param {Map<string,Candidate[]>} regions
 * @returns {QualifiedBarrier|null}
 */
function qualifyPair(pair, pageFragments, regions) {
  if (!isCompletePair(pair, pageFragments)) return null;
  const thresholds =
    pair.internalPartitionKind === "reading_start_bands"
      ? {
          minimumScore: MIN_READING_BAND_REGION_SCORE,
          minimumContainment: MIN_READING_BAND_CONTAINMENT,
        }
      : {
          minimumScore: MIN_REGION_SCORE,
          minimumContainment: MIN_CONTAINMENT,
        };
  const fragments = pair.fragments.map((fragment) =>
    qualifyFragment(fragment, regions, thresholds),
  );
  if (
    fragments.some((fragment) => fragment === null) ||
    fragments[0]?.regionId === fragments[1]?.regionId
  ) {
    return null;
  }
  const qualified = /** @type {[QualifiedFragment,QualifiedFragment]} */ (
    fragments
  );
  const smallerRegionOverlap = smallerBoxOverlapRatio(
    qualified[0].bboxPixels,
    qualified[1].bboxPixels,
  );
  if (smallerRegionOverlap > MAX_SMALLER_REGION_OVERLAP) return null;
  return {
    reviewContextId: pair.reviewContextId,
    paddleGroupId: pair.paddleGroupId,
    sourceFragmentId: pair.sourceFragmentId,
    internalPartitionKind: pair.internalPartitionKind,
    fragments: qualified,
    geometry: pair.geometry,
    smallerRegionOverlap,
  };
}

/**
 * @param {Fragment} fragment
 * @param {Map<string,Candidate[]>} regions
 * @param {{minimumScore:number;minimumContainment:number}} thresholds
 * @returns {QualifiedFragment|null}
 */
function qualifyFragment(fragment, regions, thresholds) {
  const evidence = fragment.candidates.map(readEvidence);
  if (evidence.some((item) => item === null)) return null;
  const completeEvidence = /** @type {Evidence[]} */ (evidence);
  const regionIds = new Set(completeEvidence.map((item) => item.regionId));
  if (regionIds.size !== 1) return null;
  const regionId = [...regionIds][0];
  const validated = validateUniformRegionEvidence(
    regionId,
    fragment.candidates,
  );
  if (
    !validated ||
    !validated.every((evidence) =>
      hasStrongEvidence(
        evidence,
        thresholds.minimumScore,
        thresholds.minimumContainment,
      ),
    ) ||
    !isPureFragmentRegion(fragment, regionId, regions)
  ) {
    return null;
  }
  return {
    fragment,
    regionId,
    evidence: validated,
    bboxPixels: validated[0].bboxPixels,
  };
}

/**
 * @param {Evidence} evidence
 * @param {number} minimumScore
 * @param {number} minimumContainment
 */
function hasStrongEvidence(evidence, minimumScore, minimumContainment) {
  return (
    evidence.score >= minimumScore && evidence.containment >= minimumContainment
  );
}

/** @param {Candidate[]} candidates */
function indexPageFragments(candidates) {
  /** @type {Map<string,Candidate[]>} */
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

/** @param {Candidate[]} candidates */
function indexRegions(candidates) {
  /** @type {Map<string,Candidate[]>} */
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
 * @param {PotentialBarrier} pair
 * @param {Map<string,Candidate[]>} pageFragments
 */
function isCompletePair(pair, pageFragments) {
  if (!pair.sourceFragmentId) {
    return pair.fragments.every((fragment) => {
      const pageMembers = pageFragments.get(fragment.fragmentId);
      const expected = new Set(fragment.candidates);
      return Boolean(
        pageMembers &&
        pageMembers.length === fragment.candidates.length &&
        pageMembers.every((candidate) => expected.has(candidate)),
      );
    });
  }
  const pageMembers = pageFragments.get(pair.sourceFragmentId);
  const pairMembers = pair.fragments.flatMap((fragment) => fragment.candidates);
  const uniqueMembers = new Set(pairMembers);
  return Boolean(
    pageMembers &&
    pair.fragments.every(
      (fragment) => fragment.sourceFragmentId === pair.sourceFragmentId,
    ) &&
    uniqueMembers.size === pairMembers.length &&
    pageMembers.length === pairMembers.length &&
    pageMembers.every((candidate) => uniqueMembers.has(candidate)),
  );
}

/**
 * @param {Fragment} fragment
 * @param {string} regionId
 * @param {Map<string,Candidate[]>} regions
 */
function isPureFragmentRegion(fragment, regionId, regions) {
  const members = regions.get(regionId);
  const fragmentMembers = new Set(fragment.candidates);
  return Boolean(
    members &&
    members.length === fragment.candidates.length &&
    members.every((candidate) => fragmentMembers.has(candidate)),
  );
}

/**
 * @param {string} regionId
 * @param {Candidate[]} candidates
 * @returns {Evidence[]|null}
 */
function validateUniformRegionEvidence(regionId, candidates) {
  const evidence = candidates.map(readEvidence);
  if (evidence.some((item) => item === null)) return null;
  const complete = /** @type {Evidence[]} */ (evidence);
  const reference = complete[0];
  return complete.every(
    (item) =>
      item.regionId === regionId &&
      item.score === reference.score &&
      sameBox(item.bboxPixels, reference.bboxPixels),
  )
    ? complete
    : null;
}

/** @param {Candidate} candidate @returns {Evidence|null} */
function readEvidence(candidate) {
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

module.exports = { qualifyPotentialBarriers };
