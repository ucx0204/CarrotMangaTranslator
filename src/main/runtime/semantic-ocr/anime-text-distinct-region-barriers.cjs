// @ts-check

const {
  FORBIDDEN_DEFERRED_HOST_REASONS,
} = require("./group-review-crop-contract.cjs");
const {
  qualifyPotentialBarriers,
} = require("./anime-text-distinct-region-evidence.cjs");
const {
  readCandidateBox: readBox,
  readDistinctPairGeometry: readPairGeometry,
  unionBoxes,
} = require("./anime-text-distinct-region-geometry.cjs");
const {
  buildCompleteReadingStartBandPartition,
} = require("./anime-text-reading-start-band-partition.cjs");

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

/** @param {unknown[]} candidates */
function hasPotentialDistinctAnimeTextRelation(candidates) {
  return collectPotentialBarriers(normalizeRecords(candidates)).length > 0;
}

/** @param {unknown[]} candidates */
function qualifyDistinctAnimeTextRelationRegionIds(candidates) {
  return [
    ...new Set(
      collectQualifiedBarriers(candidates).flatMap((barrier) =>
        barrier.fragments.map((fragment) => fragment.regionId),
      ),
    ),
  ];
}

/** @param {unknown[]} candidates */
function buildDistinctAnimeTextRegionBarriers(candidates) {
  return collectQualifiedBarriers(candidates).map(toSpatialRelation);
}

/**
 * @param {unknown[]} pageCandidates
 * @returns {QualifiedBarrier[]}
 */
function collectQualifiedBarriers(pageCandidates) {
  const records = normalizeRecords(pageCandidates);
  if (records.length === 0) return [];
  return qualifyPotentialBarriers(records, collectPotentialBarriers(records));
}

/**
 * Index every fragment that touches a context before applying eligibility.
 * This makes a third singleton, deferred, ruby, or otherwise invalid fragment
 * veto the entire context instead of disappearing from the count.
 *
 * @param {Candidate[]} candidates
 * @returns {PotentialBarrier[]}
 */
function collectPotentialBarriers(candidates) {
  const fragments = buildFragments(candidates);
  const byContext = indexFragmentsByContext(fragments);
  /** @type {PotentialBarrier[]} */
  const barriers = [];
  for (const [reviewContextId, contextFragments] of byContext) {
    const barrier = qualifyPotentialContext(reviewContextId, contextFragments);
    if (barrier) barriers.push(barrier);
  }
  for (const fragment of fragments) {
    const barrier = qualifyPotentialInternalPaddlePartition(
      fragment,
      byContext,
    );
    if (barrier) {
      barriers.push(barrier);
      continue;
    }
    const readingBandBarrier =
      qualifyPotentialInternalReadingStartBandPartition(fragment, byContext);
    if (readingBandBarrier) barriers.push(readingBandBarrier);
  }
  return barriers;
}

/** @param {Fragment[]} fragments */
function indexFragmentsByContext(fragments) {
  /** @type {Map<string,Fragment[]>} */
  const byContext = new Map();
  for (const fragment of fragments) {
    const contextIds = new Set(
      fragment.candidates.map(readContextId).filter(Boolean),
    );
    for (const contextId of contextIds) {
      const members = byContext.get(contextId) || [];
      members.push(fragment);
      byContext.set(contextId, members);
    }
  }
  return byContext;
}

/**
 * @param {string} reviewContextId
 * @param {Fragment[]} fragments
 * @returns {PotentialBarrier|null}
 */
function qualifyPotentialContext(reviewContextId, fragments) {
  if (fragments.length !== 2) return null;
  const metadata = fragments.map(readFragmentMetadata);
  if (
    metadata.some((item) => item === null) ||
    metadata.some((item) => item?.reviewContextId !== reviewContextId)
  ) {
    return null;
  }
  const left = /** @type {{paddleGroupId:string|null}} */ (metadata[0]);
  const right = /** @type {{paddleGroupId:string|null}} */ (metadata[1]);
  const completeMultiCandidatePair =
    fragments.every((fragment) => fragment.candidates.length >= 2) &&
    left.paddleGroupId !== null &&
    left.paddleGroupId === right.paddleGroupId;
  const paddlelessSingletonPair =
    fragments.every((fragment) => fragment.candidates.length === 1) &&
    left.paddleGroupId === null &&
    right.paddleGroupId === null;
  if (!completeMultiCandidatePair && !paddlelessSingletonPair) return null;
  // Two existing fragments in one review context are often just upper/lower
  // OCR chunks of one uninterrupted column. A reading-axis gap alone is not
  // safe enough to turn them into a hard split; require lateral separation.
  const geometry = readPairGeometry(fragments[0], fragments[1], {
    requireCrossAxisGap: true,
  });
  if (!geometry) return null;
  return {
    reviewContextId,
    paddleGroupId: left.paddleGroupId,
    sourceFragmentId: null,
    internalPartitionKind: null,
    fragments: [fragments[0], fragments[1]],
    geometry,
  };
}

/** @param {Fragment} fragment */
function readFragmentMetadata(fragment) {
  if (
    fragment.status !== "confirmed" ||
    fragment.candidates.some(hasForbiddenCandidateEvidence)
  ) {
    return null;
  }
  const reviewContextId = readUniformString(
    fragment.candidates,
    "reviewContextId",
  );
  const paddleGroup = readUniformOptionalString(
    fragment.candidates,
    "paddleGroupId",
  );
  return reviewContextId && paddleGroup.valid
    ? { reviewContextId, paddleGroupId: paddleGroup.value }
    : null;
}

/**
 * A single upstream fragment may be refined only when two non-empty Paddle
 * groups, each with at least two candidates, exactly partition that fragment.
 * A third group, missing group, mixed context, deferred/ruby evidence, or a
 * third fragment sharing its explicit context vetoes the detector trigger.
 *
 * @param {Fragment} fragment
 * @param {Map<string,Fragment[]>} byContext
 * @returns {PotentialBarrier|null}
 */
function qualifyPotentialInternalPaddlePartition(fragment, byContext) {
  if (!isEligibleInternalFragment(fragment)) return null;
  const context = readUniformOptionalString(
    fragment.candidates,
    "reviewContextId",
  );
  if (
    !context.valid ||
    (context.value && byContext.get(context.value)?.length !== 1)
  ) {
    return null;
  }
  const byPaddleGroup = buildCompletePaddlePartitions(fragment.candidates);
  if (!byPaddleGroup) return null;
  const components = [...byPaddleGroup].map(([paddleGroupId, candidates]) =>
    buildSyntheticPaddleFragment(fragment, paddleGroupId, candidates),
  );
  if (components.some((component) => component === null)) return null;
  const pair = /** @type {[Fragment,Fragment]} */ (components);
  const geometry = readPairGeometry(pair[0], pair[1]);
  if (!geometry) return null;
  return {
    reviewContextId: context.value,
    paddleGroupId: null,
    sourceFragmentId: fragment.fragmentId,
    internalPartitionKind: "paddle_groups",
    fragments: pair,
    geometry,
  };
}

/**
 * Trigger the detector for one extremely clear paragraph-band partition
 * inside a complete Paddle group. It becomes a split only after both bands
 * receive strong, pure, non-overlapping detector regions.
 *
 * @param {Fragment} fragment
 * @param {Map<string,Fragment[]>} byContext
 * @returns {PotentialBarrier|null}
 */
function qualifyPotentialInternalReadingStartBandPartition(
  fragment,
  byContext,
) {
  if (!isEligibleInternalFragment(fragment)) return null;
  const context = readUniformOptionalString(
    fragment.candidates,
    "reviewContextId",
  );
  if (
    !context.valid ||
    (context.value && byContext.get(context.value)?.length !== 1)
  ) {
    return null;
  }
  const partition = buildCompleteReadingStartBandPartition(fragment);
  if (!partition) return null;
  const geometry = readPairGeometry(
    partition.fragments[0],
    partition.fragments[1],
  );
  if (!geometry) return null;
  return {
    reviewContextId: context.value,
    paddleGroupId: partition.paddleGroupId,
    sourceFragmentId: fragment.fragmentId,
    internalPartitionKind: "reading_start_bands",
    fragments: partition.fragments,
    geometry,
  };
}

/** @param {Fragment} fragment */
function isEligibleInternalFragment(fragment) {
  return (
    fragment.status === "confirmed" &&
    fragment.candidates.length >= 4 &&
    !fragment.candidates.some(hasForbiddenCandidateEvidence)
  );
}

/**
 * @param {Candidate[]} candidates
 * @returns {Map<string,Candidate[]>|null}
 */
function buildCompletePaddlePartitions(candidates) {
  /** @type {Map<string,Candidate[]>} */
  const byPaddleGroup = new Map();
  for (const candidate of candidates) {
    const paddleGroupId = readCandidateString(candidate, "paddleGroupId");
    if (!/^G\d{3,4}$/.test(paddleGroupId)) return null;
    const members = byPaddleGroup.get(paddleGroupId) || [];
    members.push(candidate);
    byPaddleGroup.set(paddleGroupId, members);
  }
  const groups = [...byPaddleGroup.values()];
  return byPaddleGroup.size === 2 &&
    groups.every(
      (members) => members.length >= 2 && hasCompletePaddleSidecar(members),
    )
    ? byPaddleGroup
    : null;
}

/**
 * @param {Fragment} source
 * @param {string} paddleGroupId
 * @param {Candidate[]} candidates
 * @returns {Fragment|null}
 */
function buildSyntheticPaddleFragment(source, paddleGroupId, candidates) {
  const boxes = candidates.map(readBox);
  if (boxes.some((box) => box === null)) return null;
  const bbox = /** @type {Box[]} */ (boxes).reduce(unionBoxes);
  const syntheticFragmentId = `${source.fragmentId}::paddle::${paddleGroupId}`;
  return {
    fragmentId: syntheticFragmentId,
    sourceFragmentId: source.fragmentId,
    syntheticFragmentId,
    paddleGroupId,
    status: source.status,
    candidates,
    bbox,
  };
}

/** @param {Candidate} candidate */
function hasForbiddenCandidateEvidence(candidate) {
  return (
    candidate.reviewRole === "ruby" ||
    candidate.role === "ruby" ||
    reasonsAreForbidden(candidate.reviewReasons)
  );
}

/**
 * @param {Candidate[]} candidates
 * @param {"reviewContextId"|"paddleGroupId"} key
 */
function readUniformString(candidates, key) {
  const values = candidates.map((candidate) =>
    typeof candidate[key] === "string" ? candidate[key].trim() : "",
  );
  return values[0] && new Set(values).size === 1 ? values[0] : null;
}

/**
 * @param {Candidate[]} candidates
 * @param {"reviewContextId"|"paddleGroupId"} key
 */
function readUniformOptionalString(candidates, key) {
  const values = candidates.map((candidate) =>
    readCandidateString(candidate, key),
  );
  return new Set(values).size === 1
    ? { valid: true, value: values[0] || null }
    : { valid: false, value: null };
}

/**
 * @param {Candidate} candidate
 * @param {"reviewContextId"|"paddleGroupId"} key
 */
function readCandidateString(candidate, key) {
  return typeof candidate[key] === "string" ? candidate[key].trim() : "";
}

/** @param {Candidate[]} candidates */
function hasCompletePaddleSidecar(candidates) {
  const expectedSize = candidates.length;
  const orders = candidates.map((candidate) => Number(candidate.paddleOrder));
  return (
    candidates.every(
      (candidate) =>
        Number(candidate.paddleGroupSize) === expectedSize &&
        Number.isInteger(candidate.paddleOrder) &&
        Number(candidate.paddleOrder) >= 1 &&
        Number(candidate.paddleOrder) <= expectedSize,
    ) && new Set(orders).size === expectedSize
  );
}

/** @param {Candidate[]} candidates @returns {Fragment[]} */
function buildFragments(candidates) {
  /** @type {Map<string,Fragment>} */
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
    const existing = fragments.get(fragmentId);
    if (existing) {
      if (existing.status !== status) return [];
      existing.candidates.push(candidate);
      existing.bbox = unionBoxes(existing.bbox, bbox);
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

/** @param {unknown[]} candidates @returns {Candidate[]} */
function normalizeRecords(candidates) {
  if (!Array.isArray(candidates)) return [];
  return /** @type {Candidate[]} */ (
    candidates.filter(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate),
    )
  );
}

/** @param {QualifiedBarrier} barrier */
function toSpatialRelation(barrier) {
  const internalSplit = Boolean(barrier.sourceFragmentId);
  const hardReadingBandSplit =
    barrier.internalPartitionKind === "reading_start_bands";
  return {
    kind: "distinct_anime_text_regions",
    strength: hardReadingBandSplit
      ? "conservative_merge_barrier"
      : internalSplit
        ? "conservative_split_prior"
        : "conservative_merge_barrier",
    basis: hardReadingBandSplit
      ? "one_complete_paddle_group_partitioned_by_two_clear_reading_start_bands_in_distinct_pure_detector_regions"
      : barrier.sourceFragmentId
        ? "one_complete_confirmed_fragment_partitioned_by_two_paddle_groups_in_distinct_pure_detector_regions"
        : "two_complete_confirmed_fragments_in_distinct_pure_detector_regions",
    recommendedAction: hardReadingBandSplit
      ? "keep_fragments_separate"
      : internalSplit
        ? "prefer_fragments_separate"
        : "keep_fragments_separate",
    ...(barrier.reviewContextId
      ? { reviewContextId: barrier.reviewContextId }
      : {}),
    ...(barrier.paddleGroupId ? { paddleGroupId: barrier.paddleGroupId } : {}),
    ...(barrier.sourceFragmentId
      ? {
          sourceFragmentId: barrier.sourceFragmentId,
          ...(barrier.internalPartitionKind
            ? { internalPartitionKind: barrier.internalPartitionKind }
            : {}),
          paddleGroupIds: barrier.fragments.map(
            (item) => item.fragment.paddleGroupId,
          ),
        }
      : {}),
    geometry: barrier.geometry,
    fragments: barrier.fragments.map((item) => ({
      fragmentId: item.fragment.fragmentId,
      ...(item.fragment.syntheticFragmentId
        ? {
            sourceFragmentId: item.fragment.sourceFragmentId,
            syntheticFragmentId: item.fragment.syntheticFragmentId,
            paddleGroupId: item.fragment.paddleGroupId,
            ...(item.fragment.partitionKey
              ? { partitionKey: item.fragment.partitionKey }
              : {}),
          }
        : {}),
      candidateIds: item.fragment.candidates.map((candidate) => candidate.id),
      regionId: item.regionId,
      score: Math.min(...item.evidence.map((evidence) => evidence.score)),
      bboxPixels: item.bboxPixels,
      candidateCoverage: item.fragment.candidates.map((candidate, index) => ({
        id: candidate.id,
        coverage: item.evidence[index].containment,
      })),
    })),
    smallerRegionOverlap: roundRatio(barrier.smallerRegionOverlap),
  };
}

/** @param {Candidate} value */
function readContextId(value) {
  return typeof value.reviewContextId === "string"
    ? value.reviewContextId.trim()
    : "";
}

/** @param {unknown} value */
function reasonsAreForbidden(value) {
  if (value === undefined) return false;
  if (!Array.isArray(value)) return true;
  return value.some((reason) =>
    FORBIDDEN_DEFERRED_HOST_REASONS.has(String(reason)),
  );
}

/** @param {number} value */
function roundRatio(value) {
  return Math.round(value * 10_000) / 10_000;
}

module.exports = {
  buildDistinctAnimeTextRegionBarriers,
  hasPotentialDistinctAnimeTextRelation,
  qualifyDistinctAnimeTextRelationRegionIds,
};
