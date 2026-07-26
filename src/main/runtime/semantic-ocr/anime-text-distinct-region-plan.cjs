// @ts-check

/**
 * @typedef {Record<string,unknown>} JsonRecord
 * @typedef {{fragment:string;status:string;candidateIds:number[]}} UpstreamFragment
 * @typedef {{fragmentId:string;candidateIds:number[];regionId:string;paddleGroupId:string|null;partitionKey:string|null}} BarrierFragment
 */

/**
 * A qualified detector relation may correct one over-merged confirmed
 * fragment only when two non-empty Paddle groups form an exact partition of
 * that fragment. Refining the plan here lets both model validation and the
 * deterministic fallback use the detector-certified boundary.
 *
 * @param {UpstreamFragment[]} upstreamFragments
 * @param {unknown} spatialRelations
 * @returns {UpstreamFragment[]}
 */
function refineUpstreamFragmentsForDistinctAnimeTextRegions(
  upstreamFragments,
  spatialRelations,
) {
  const relations = readBarrierArray(spatialRelations);
  if (relations.length === 0) return upstreamFragments;
  let refined = upstreamFragments.map(copyFragment);
  for (const relation of relations) {
    const split = readInternalFragmentSplit(relation, refined);
    if (!split) continue;
    refined = [
      ...refined.slice(0, split.sourceIndex),
      ...split.fragments.map((fragment) => ({
        fragment: fragment.fragmentId,
        status: "confirmed",
        candidateIds: [...fragment.candidateIds],
      })),
      ...refined.slice(split.sourceIndex + 1),
    ];
  }
  return sameFragments(refined, upstreamFragments)
    ? upstreamFragments
    : refined;
}

/**
 * Read a hard barrier only when both relation components exactly match two
 * confirmed fragments in the already-refined review plan.
 *
 * @param {{upstreamFragments:UpstreamFragment[]}} plan
 * @param {unknown} value
 * @returns {[number[],number[]]|null}
 */
function readDistinctAnimeTextRegionBarrierCandidatePair(plan, value) {
  if (!isHardBarrierRecord(value)) return null;
  const upstreamByName = new Map(
    plan.upstreamFragments.map((fragment) => [fragment.fragment, fragment]),
  );
  const fragments = value.fragments.map((fragment) =>
    readBarrierFragment(fragment),
  );
  if (fragments.some((fragment) => fragment === null)) return null;
  const pair = /** @type {[BarrierFragment,BarrierFragment]} */ (fragments);
  if (pair[0].regionId === pair[1].regionId) return null;
  for (const fragment of pair) {
    const upstream = upstreamByName.get(fragment.fragmentId);
    if (
      !upstream ||
      upstream.status !== "confirmed" ||
      !sameIntegerSet(fragment.candidateIds, upstream.candidateIds)
    ) {
      return null;
    }
  }
  return [pair[0].candidateIds, pair[1].candidateIds];
}

/**
 * @param {unknown} value
 * @param {UpstreamFragment[]} fragments
 */
function readInternalFragmentSplit(value, fragments) {
  if (!isInternalSplitRecord(value)) return null;
  const sourceFragmentId = readString(value.sourceFragmentId);
  if (!sourceFragmentId) return null;
  const sourceIndex = fragments.findIndex(
    (fragment) => fragment.fragment === sourceFragmentId,
  );
  if (sourceIndex < 0) return null;
  const source = fragments[sourceIndex];
  if (source.status !== "confirmed") return null;
  const components = value.fragments.map((fragment) =>
    readBarrierFragment(fragment),
  );
  if (components.some((fragment) => fragment === null)) return null;
  const pair = /** @type {[BarrierFragment,BarrierFragment]} */ (components);
  if (!isValidInternalPair(pair, sourceFragmentId, value)) return null;
  const otherNames = new Set(
    fragments
      .filter((_fragment, index) => index !== sourceIndex)
      .map((fragment) => fragment.fragment),
  );
  if (
    pair.some((fragment) => otherNames.has(fragment.fragmentId)) ||
    !isExactCandidatePartition(pair, source.candidateIds)
  ) {
    return null;
  }
  return { sourceIndex, fragments: pair };
}

/**
 * @param {[BarrierFragment,BarrierFragment]} pair
 * @param {string} sourceFragmentId
 * @param {JsonRecord} relation
 */
function isValidInternalPair(pair, sourceFragmentId, relation) {
  const invalidComponent = pair.some(
    (fragment) =>
      fragment.fragmentId === sourceFragmentId ||
      fragment.candidateIds.length < 2 ||
      !fragment.paddleGroupId,
  );
  const readingStartBands =
    relation.internalPartitionKind === "reading_start_bands" &&
    relation.strength === "conservative_merge_barrier" &&
    relation.recommendedAction === "keep_fragments_separate" &&
    readString(relation.paddleGroupId) === pair[0].paddleGroupId &&
    pair[0].paddleGroupId === pair[1].paddleGroupId &&
    new Set(pair.map((fragment) => fragment.partitionKey)).size === 2 &&
    pair.every(
      (fragment) =>
        fragment.partitionKey === "band-1" ||
        fragment.partitionKey === "band-2",
    );
  const paddlePartitions =
    relation.internalPartitionKind !== "reading_start_bands" &&
    pair[0].paddleGroupId !== pair[1].paddleGroupId;
  return (
    !invalidComponent &&
    pair[0].fragmentId !== pair[1].fragmentId &&
    (readingStartBands || paddlePartitions) &&
    pair[0].regionId !== pair[1].regionId
  );
}

/**
 * @param {[BarrierFragment,BarrierFragment]} pair
 * @param {number[]} sourceCandidateIds
 */
function isExactCandidatePartition(pair, sourceCandidateIds) {
  const candidateIds = pair.flatMap((fragment) => fragment.candidateIds);
  return (
    new Set(candidateIds).size === candidateIds.length &&
    sameIntegerSet(candidateIds, sourceCandidateIds)
  );
}

/** @param {unknown} value @returns {value is JsonRecord & {fragments:unknown[]}} */
function isBaseRelationRecord(value) {
  if (!isRecord(value)) return false;
  return (
    value.kind === "distinct_anime_text_regions" &&
    Array.isArray(value.fragments) &&
    value.fragments.length === 2
  );
}

/** @param {unknown} value @returns {value is JsonRecord & {fragments:unknown[]}} */
function isHardBarrierRecord(value) {
  if (
    !isBaseRelationRecord(value) ||
    value.strength !== "conservative_merge_barrier" ||
    value.recommendedAction !== "keep_fragments_separate"
  ) {
    return false;
  }
  const sourceFragmentId = readString(value.sourceFragmentId);
  return (
    (Boolean(readString(value.reviewContextId)) && !sourceFragmentId) ||
    (Boolean(sourceFragmentId) &&
      value.internalPartitionKind === "reading_start_bands")
  );
}

/** @param {unknown} value @returns {value is JsonRecord & {fragments:unknown[]}} */
function isInternalSplitRecord(value) {
  if (!isBaseRelationRecord(value) || !readString(value.sourceFragmentId)) {
    return false;
  }
  return (
    (value.strength === "conservative_split_prior" &&
      value.recommendedAction === "prefer_fragments_separate") ||
    (value.strength === "conservative_merge_barrier" &&
      value.recommendedAction === "keep_fragments_separate")
  );
}

/** @param {unknown} value @returns {BarrierFragment|null} */
function readBarrierFragment(value) {
  if (!isRecord(value)) return null;
  const fragmentId = readString(value.fragmentId);
  const regionId = readString(value.regionId);
  const candidateIds = readIntegerArray(value.candidateIds);
  if (
    !fragmentId ||
    !regionId ||
    !/^ATY\d{3,4}$/.test(regionId) ||
    !candidateIds
  ) {
    return null;
  }
  return {
    fragmentId,
    candidateIds,
    regionId,
    paddleGroupId: readString(value.paddleGroupId),
    partitionKey: readString(value.partitionKey),
  };
}

/** @param {unknown} value */
function readBarrierArray(value) {
  if (!isRecord(value)) return [];
  return Array.isArray(value.distinctAnimeTextRegionBarriers)
    ? value.distinctAnimeTextRegionBarriers
    : [];
}

/** @param {unknown} value @returns {number[]|null} */
function readIntegerArray(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !Number.isInteger(item) || Number(item) <= 0) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value.map(Number);
}

/** @param {unknown} value @returns {string|null} */
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value @returns {value is JsonRecord} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {number[]} left @param {number[]} right */
function sameIntegerSet(left, right) {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

/** @param {UpstreamFragment} fragment */
function copyFragment(fragment) {
  return { ...fragment, candidateIds: [...fragment.candidateIds] };
}

/** @param {UpstreamFragment[]} left @param {UpstreamFragment[]} right */
function sameFragments(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

module.exports = {
  readDistinctAnimeTextRegionBarrierCandidatePair,
  refineUpstreamFragmentsForDistinctAnimeTextRegions,
};
