// @ts-check

const {
  assertBoxInsidePage,
  normalizeCandidateBox,
  normalizeOptionalPositiveInteger,
  normalizeOptionalString,
  normalizeReasons,
  requireInteger,
  requirePositiveInteger,
  unionBoxes,
} = require("./group-review-crop-geometry.cjs");
const {
  readAnimeTextEvidence,
} = require("../ocr/anime-text-evidence-contract.cjs");

/** @typedef {import("./group-review-crop-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-review-crop-types").NormalizedCandidate} NormalizedCandidate */
/** @typedef {import("./group-review-crop-types").ReviewFragment} ReviewFragment */

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
    return normalizeCandidate(candidate, id, pageWidth, pageHeight);
  });
}

/**
 * @param {ReviewCandidate} candidate
 * @param {number} id
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {NormalizedCandidate}
 */
function normalizeCandidate(candidate, id, pageWidth, pageHeight) {
  const fragmentId = String(candidate.reviewFragmentId ?? "").trim();
  if (!fragmentId) {
    throw new Error(`candidate ${id} is missing reviewFragmentId.`);
  }
  const status = readReviewStatus(candidate.reviewStatus, id);
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
    reviewContextId: normalizeReviewContextId(
      candidate.reviewContextId,
      id,
      status,
    ),
    ...normalizeAnimeTextEvidence(candidate, id),
  };
}

/** @param {unknown} value @param {number} candidateId */
function readReviewStatus(value, candidateId) {
  if (value === "confirmed" || value === "deferred") {
    return value;
  }
  throw new Error(
    `candidate ${candidateId} reviewStatus must be confirmed or deferred.`,
  );
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
  const fragments = [...byFragment.entries()].map(([fragmentId, members]) =>
    buildFragment(fragmentId, members),
  );
  fragments.sort((left, right) =>
    left.fragmentId.localeCompare(right.fragmentId),
  );
  return fragments;
}

/**
 * @param {string} fragmentId
 * @param {NormalizedCandidate[]} members
 * @returns {ReviewFragment}
 */
function buildFragment(fragmentId, members) {
  requireUniformFragmentMetadata(fragmentId, members);
  members.sort((left, right) => left.order - right.order || left.id - right.id);
  return {
    fragmentId,
    status: members[0].status,
    reasons: [
      ...new Set(members.flatMap((candidate) => candidate.reasons)),
    ].sort(),
    reviewContextId: members[0].reviewContextId,
    candidates: members,
    bbox: unionBoxes(members.map((candidate) => candidate.bbox)),
  };
}

/** @param {string} fragmentId @param {NormalizedCandidate[]} members */
function requireUniformFragmentMetadata(fragmentId, members) {
  if (new Set(members.map((candidate) => candidate.status)).size !== 1) {
    throw new Error(`Fragment ${fragmentId} has mixed reviewStatus values.`);
  }
  const orders = members.map((candidate) => candidate.order);
  if (new Set(orders).size !== orders.length) {
    throw new Error(`Fragment ${fragmentId} has duplicate reviewOrder values.`);
  }
  if (
    new Set(members.map((candidate) => candidate.reviewContextId)).size !== 1
  ) {
    throw new Error(
      `Fragment ${fragmentId} has inconsistent reviewContextId metadata.`,
    );
  }
}

/**
 * @param {unknown} value
 * @param {number} candidateId
 * @param {"confirmed"|"deferred"} status
 */
function normalizeReviewContextId(value, candidateId, status) {
  if (value === undefined || value === null) {
    return null;
  }
  const contextId = String(value).trim().toUpperCase();
  if (!/^RC\d{3,4}$/.test(contextId)) {
    throw new Error(`candidate ${candidateId}.reviewContextId is malformed.`);
  }
  if (status !== "confirmed") {
    throw new Error(
      `candidate ${candidateId}.reviewContextId requires confirmed reviewStatus.`,
    );
  }
  return contextId;
}

/** @param {ReviewCandidate} candidate @param {number} candidateId */
function normalizeAnimeTextEvidence(candidate, candidateId) {
  const evidence = readAnimeTextEvidence(candidate, `candidate ${candidateId}`);
  return evidence
    ? {
        animeTextRegionId: evidence.animeTextRegionId,
        animeTextRegionScore: evidence.animeTextRegionScore,
        animeTextContainment: evidence.animeTextContainment,
      }
    : {
        animeTextRegionId: null,
        animeTextRegionScore: null,
        animeTextContainment: null,
      };
}

module.exports = { buildFragments, normalizeCandidates };
