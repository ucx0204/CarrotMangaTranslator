// @ts-check

const { readOcrCandidateText } = require("../prompts/ocr-text.cjs");
const { isRecord } = require("./values.cjs");
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
  unionBoxes,
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
  const upstreamFragments = normalizeFragments(
    reviewCase.upstreamFragments ?? reviewCase.currentGroups,
    candidateOrder,
  );
  return {
    version: GROUP_ONLY_REVIEW_VERSION,
    reviewCase,
    region,
    candidates,
    candidateOrder,
    upstreamFragments,
    spatialRelations: isRecord(reviewCase.spatialRelations)
      ? reviewCase.spatialRelations
      : {},
  };
}

module.exports = { buildGroupOnlyReviewPlan };
