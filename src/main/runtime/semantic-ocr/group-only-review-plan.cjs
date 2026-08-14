// @ts-check

const { readOcrCandidateText } = require("../prompts/ocr-text.cjs");
const { isRecord } = require("./values.cjs");
const {
  refineUpstreamFragmentsForDistinctAnimeTextRegions,
  readDistinctAnimeTextRegionBarrierCandidatePair,
} = require("./anime-text-distinct-region-plan.cjs");
const { unionBoxes } = require("./box-geometry.cjs");
const {
  readCompleteTwoCandidatePaddleClassifierSplit,
} = require("./paddle-classifier-recovery.cjs");
const {
  GROUP_ONLY_REVIEW_VERSION,
  fail,
  normalizeFragments,
  optionalBox,
  optionalString,
  pixelBox,
  positive,
  record,
  toCrop1000,
  tupleBox,
} = require("./group-only-review-values.cjs");

/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

/**
 * candidates/hints is the canonical raw Paddle-hint array in exact model input
 * order. Original Paddle evidence is read only from sidecar fields
 * paddleGroupId/paddleOrder, never from a final groupId.
 *
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} [region]
 * @returns {ReviewPlan}
 */
function buildGroupOnlyReviewPlan(reviewCase, region = {}) {
  record(reviewCase, "review case");
  record(region, "review region");
  const raw = /** @type {unknown[]} */ (
    Array.isArray(reviewCase.candidates)
      ? reviewCase.candidates
      : reviewCase.hints
  );
  if (!Array.isArray(raw) || !raw.length)
    fail("candidates", "Candidates must be a non-empty array.");
  const seen = new Set();
  const prelim = raw.map((value, index) => {
    const hint = record(value, `candidate ${index + 1}`);
    const id = positive(hint.id);
    if (!id || seen.has(id))
      fail(
        "candidate-id",
        `Candidate ${index + 1} needs a unique positive id.`,
      );
    seen.add(id);
    return { id, index, hint, bbox: pixelBox(hint, `candidate ${id}`) };
  });
  const crop =
    optionalBox(region.cropBbox ?? region.bbox ?? region) ??
    unionBoxes(prelim.map((item) => item.bbox));
  const candidates = prelim.map((item) => ({
    ...item,
    text: readOcrCandidateText(item.hint),
    score: Number.isFinite(Number(item.hint.score))
      ? Number(item.hint.score)
      : null,
    bbox1000: tupleBox(item.hint.bbox1000) ?? toCrop1000(item.bbox, crop),
    paddleGroup: optionalString(
      item.hint.paddleGroupId ?? item.hint.paddleGroup,
    ),
    paddleOrder: positive(item.hint.paddleOrder),
  }));
  const candidateOrder = candidates.map((item) => item.id);
  if (
    reviewCase.candidateOrder !== undefined &&
    JSON.stringify(reviewCase.candidateOrder) !== JSON.stringify(candidateOrder)
  ) {
    fail("candidate-order", "candidateOrder must exactly match candidates.");
  }
  const spatialRelations = isRecord(reviewCase.spatialRelations)
    ? reviewCase.spatialRelations
    : {};
  const upstreamFragments = refineUpstreamFragmentsForDistinctAnimeTextRegions(
    recoverCompleteTwoCandidatePaddleClassifierSplit(
      normalizeFragments(
        reviewCase.upstreamFragments ?? reviewCase.currentGroups,
        candidateOrder,
      ),
      candidates,
      candidateOrder,
      spatialRelations,
    ),
    spatialRelations,
  );
  return {
    version: GROUP_ONLY_REVIEW_VERSION,
    reviewCase,
    region,
    candidates,
    candidateOrder,
    upstreamFragments,
    spatialRelations,
  };
}

/**
 * Treat an exact classifier-only Paddle disagreement as one immutable review
 * fragment, but only when the page-wide relation authorizes the recovery.
 *
 * @param {import("./group-only-review-types").UpstreamFragment[]} fragments
 * @param {import("./group-only-review-types").ReviewCandidate[]} candidates
 * @param {number[]} candidateOrder
 * @param {Record<string,unknown>} spatialRelations
 */
function recoverCompleteTwoCandidatePaddleClassifierSplit(
  fragments,
  candidates,
  candidateOrder,
  spatialRelations,
) {
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const consumed = new Set();
  const result = [];
  for (let index = 0; index < fragments.length; index += 1) {
    if (consumed.has(index)) continue;
    const left = fragments[index];
    let recovered = null;
    for (
      let otherIndex = index + 1;
      otherIndex < fragments.length;
      otherIndex += 1
    ) {
      if (consumed.has(otherIndex)) continue;
      const right = fragments[otherIndex];
      const targetFragmentId = readMatchingPaddleClassifierRecovery(
        spatialRelations,
        left,
        right,
        candidateById,
      );
      if (!targetFragmentId) continue;
      recovered = { otherIndex, right, targetFragmentId };
      break;
    }
    if (!recovered) {
      result.push(left);
      continue;
    }
    consumed.add(recovered.otherIndex);
    result.push({
      fragment: recovered.targetFragmentId,
      status: "confirmed",
      candidateIds: candidateOrder.filter(
        (id) =>
          left.candidateIds.includes(id) ||
          recovered.right.candidateIds.includes(id),
      ),
    });
  }
  return result.length === fragments.length ? fragments : result;
}

/**
 * @param {Record<string,unknown>} spatialRelations
 * @param {import("./group-only-review-types").UpstreamFragment} left
 * @param {import("./group-only-review-types").UpstreamFragment} right
 * @param {Map<number,import("./group-only-review-types").ReviewCandidate>} candidateById
 */
function readMatchingPaddleClassifierRecovery(
  spatialRelations,
  left,
  right,
  candidateById,
) {
  const split = readCompleteTwoCandidatePaddleClassifierSplit(
    left,
    right,
    candidateById,
  );
  if (!split) return null;
  const sourceIds = [left.fragment, right.fragment].sort();
  const candidateIds = [...left.candidateIds, ...right.candidateIds].sort(
    (first, second) => first - second,
  );
  const expectedTarget = `${split.confirmedFragment.fragment}::paddle-recovery::${split.paddleGroupId}`;
  const relations = Array.isArray(spatialRelations.paddleClassifierRecoveries)
    ? spatialRelations.paddleClassifierRecoveries.filter(isRecord)
    : [];
  const matches = relations.filter((relation) => {
    const relationSources = Array.isArray(relation.sourceFragmentIds)
      ? relation.sourceFragmentIds.map(String).sort()
      : [];
    const relationCandidates = Array.isArray(relation.candidateIds)
      ? relation.candidateIds
          .map(Number)
          .filter(Number.isInteger)
          .sort((first, second) => first - second)
      : [];
    return (
      relation.kind === "complete_paddle_classifier_recovery" &&
      relation.strength === "exact_upstream_fragment_recovery" &&
      relation.recommendedAction === "merge_fragments" &&
      optionalString(relation.paddleGroupId) === split.paddleGroupId &&
      optionalString(relation.targetFragmentId) === expectedTarget &&
      JSON.stringify(relationSources) === JSON.stringify(sourceIds) &&
      JSON.stringify(relationCandidates) === JSON.stringify(candidateIds)
    );
  });
  return matches.length === 1 ? String(matches[0].targetFragmentId) : null;
}

/**
 * @param {ReviewPlan} plan
 * @param {number[]} leftIds
 * @param {number[]} rightIds
 */
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

module.exports = {
  buildGroupOnlyReviewPlan,
  pairCrossesDistinctRegionBarrier,
};
