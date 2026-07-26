// @ts-check

const { isRecord } = require("./values.cjs");

/**
 * @typedef {{
 *   id?:unknown;
 *   x1?:unknown;
 *   y1?:unknown;
 *   x2?:unknown;
 *   y2?:unknown;
 *   bbox?:unknown;
 *   hint?:unknown;
 *   reviewFragmentId?:unknown;
 *   reviewStatus?:unknown;
 *   reviewReasons?:unknown;
 *   paddleGroup?:unknown;
 *   paddleGroupId?:unknown;
 *   paddleOrder?:unknown;
 *   paddleGroupSize?:unknown;
 * }} CandidateLike
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} Box
 * @typedef {{
 *   fragmentId:string;
 *   status:"confirmed"|"deferred";
 *   candidates:CandidateLike[];
 * }} RawReviewFragment
 */

/** @param {unknown[]} pageCandidates */
function buildPaddleClassifierRecoveryRelations(pageCandidates) {
  if (!Array.isArray(pageCandidates)) return [];
  const candidates = pageCandidates.filter(isRecord);
  const fragments = collectRawReviewFragments(candidates);
  const consumed = new Set();
  const relations = [];
  for (let index = 0; index < fragments.length; index += 1) {
    if (consumed.has(index)) continue;
    for (
      let otherIndex = index + 1;
      otherIndex < fragments.length;
      otherIndex += 1
    ) {
      if (consumed.has(otherIndex)) continue;
      const relation = readRawRecoveryRelation(
        fragments[index],
        fragments[otherIndex],
        candidates,
      );
      if (!relation) continue;
      consumed.add(index);
      consumed.add(otherIndex);
      relations.push(relation);
      break;
    }
  }
  return relations;
}

/**
 * @param {import("./group-review-crop-types").ReviewFragment} confirmed
 * @param {import("./group-review-crop-types").ReviewFragment} deferred
 */
function canRecoverCompleteTwoCandidatePaddleGroup(confirmed, deferred) {
  if (confirmed.candidates.length !== 1 || deferred.candidates.length !== 1) {
    return false;
  }
  return Boolean(
    readClassifierRecoveryGroupId(
      confirmed.candidates[0],
      deferred.candidates[0],
      deferred.reasons,
    ),
  );
}

/**
 * @param {import("./group-only-review-types").UpstreamFragment} left
 * @param {import("./group-only-review-types").UpstreamFragment} right
 * @param {Map<number,import("./group-only-review-types").ReviewCandidate>} candidateById
 */
function readCompleteTwoCandidatePaddleClassifierSplit(
  left,
  right,
  candidateById,
) {
  const split = readConfirmedDeferredPair(left, right);
  if (
    !split ||
    left.candidateIds.length !== 1 ||
    right.candidateIds.length !== 1
  ) {
    return null;
  }
  const leftCandidate = candidateById.get(left.candidateIds[0]);
  const rightCandidate = candidateById.get(right.candidateIds[0]);
  if (!leftCandidate || !rightCandidate) return null;
  const confirmedCandidate =
    split.confirmed === left ? leftCandidate : rightCandidate;
  const deferredCandidate =
    split.deferred === left ? leftCandidate : rightCandidate;
  const paddleGroupId = readClassifierRecoveryGroupId(
    confirmedCandidate,
    deferredCandidate,
    readHintReasons(deferredCandidate),
  );
  return paddleGroupId
    ? { confirmedFragment: split.confirmed, paddleGroupId }
    : null;
}

/**
 * @param {RawReviewFragment} left
 * @param {RawReviewFragment} right
 * @param {CandidateLike[]} candidateOrder
 */
function readRawRecoveryRelation(left, right, candidateOrder) {
  const split = readConfirmedDeferredPair(left, right);
  if (
    !split ||
    split.confirmed.candidates.length !== 1 ||
    split.deferred.candidates.length !== 1
  ) {
    return null;
  }
  const confirmedCandidate = split.confirmed.candidates[0];
  const deferredCandidate = split.deferred.candidates[0];
  const paddleGroupId = readClassifierRecoveryGroupId(
    confirmedCandidate,
    deferredCandidate,
    deferredCandidate.reviewReasons,
  );
  if (!paddleGroupId) return null;
  const memberSet = new Set([confirmedCandidate, deferredCandidate]);
  const candidateIds = candidateOrder
    .filter((candidate) => memberSet.has(candidate))
    .map((candidate) => Number(candidate.id));
  if (
    candidateIds.length !== 2 ||
    candidateIds.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    return null;
  }
  return {
    kind: "complete_paddle_classifier_recovery",
    strength: "exact_upstream_fragment_recovery",
    basis:
      "complete_two_candidate_paddle_group_split_only_by_uncertain_sfx_classifier",
    recommendedAction: "merge_fragments",
    paddleGroupId,
    sourceFragmentIds: [split.confirmed.fragmentId, split.deferred.fragmentId],
    targetFragmentId: `${split.confirmed.fragmentId}::paddle-recovery::${paddleGroupId}`,
    candidateIds,
  };
}

/**
 * @param {CandidateLike} confirmed
 * @param {CandidateLike} deferred
 * @param {unknown} deferredReasons
 */
function readClassifierRecoveryGroupId(confirmed, deferred, deferredReasons) {
  if (!hasUncertainSfxOnlyReason(deferredReasons)) return null;
  const candidates = [confirmed, deferred];
  const paddleGroupId = readPaddleGroupId(confirmed);
  const orders = candidates.map((candidate) => Number(candidate.paddleOrder));
  if (
    !paddleGroupId ||
    readPaddleGroupId(deferred) !== paddleGroupId ||
    candidates.some((candidate) => readPaddleGroupSize(candidate) !== 2) ||
    new Set(orders).size !== 2 ||
    !orders.every((order) => order === 1 || order === 2) ||
    !hasAlignedTwoCandidateGeometry(confirmed, deferred)
  ) {
    return null;
  }
  return paddleGroupId;
}

/** @param {Record<string,unknown>[]} candidates @returns {RawReviewFragment[]} */
function collectRawReviewFragments(candidates) {
  /** @type {Map<string,RawReviewFragment>} */
  const fragments = new Map();
  for (const candidate of candidates) {
    const fragmentId = String(candidate.reviewFragmentId ?? "").trim();
    const status = candidate.reviewStatus;
    if (
      !fragmentId ||
      (status !== "confirmed" && status !== "deferred") ||
      !readBox(candidate)
    ) {
      return [];
    }
    const fragment = fragments.get(fragmentId);
    if (fragment) {
      if (fragment.status !== status) return [];
      fragment.candidates.push(candidate);
    } else {
      fragments.set(fragmentId, {
        fragmentId,
        status,
        candidates: [candidate],
      });
    }
  }
  return [...fragments.values()];
}

/**
 * @template {{status:string}} T
 * @param {T} left
 * @param {T} right
 * @returns {{confirmed:T;deferred:T}|null}
 */
function readConfirmedDeferredPair(left, right) {
  if (new Set([left.status, right.status]).size !== 2) return null;
  const confirmed =
    left.status === "confirmed"
      ? left
      : right.status === "confirmed"
        ? right
        : null;
  const deferred =
    left.status === "deferred"
      ? left
      : right.status === "deferred"
        ? right
        : null;
  return confirmed && deferred ? { confirmed, deferred } : null;
}

/** @param {CandidateLike} candidate */
function readPaddleGroupId(candidate) {
  const value = candidate.paddleGroupId ?? candidate.paddleGroup;
  return String(value ?? "").trim() || null;
}

/** @param {CandidateLike} candidate */
function readPaddleGroupSize(candidate) {
  const hint = isRecord(candidate.hint) ? candidate.hint : {};
  return Number(candidate.paddleGroupSize ?? hint.paddleGroupSize);
}

/** @param {CandidateLike} candidate */
function readHintReasons(candidate) {
  return isRecord(candidate.hint) ? candidate.hint.reviewReasons : undefined;
}

/** @param {unknown} value */
function hasUncertainSfxOnlyReason(value) {
  if (!Array.isArray(value)) return false;
  const reasons = value.map(String);
  return (
    reasons.includes("oversized_uncertain_sfx") &&
    !reasons.includes("oversized_display_text")
  );
}

/** @param {CandidateLike} left @param {CandidateLike} right */
function hasAlignedTwoCandidateGeometry(left, right) {
  const leftBox = readBox(left);
  const rightBox = readBox(right);
  if (!leftBox || !rightBox) return false;
  const boxes = [leftBox, rightBox];
  const vertical = boxes.every(isVerticalBox);
  const horizontal = boxes.every(isHorizontalBox);
  if (!vertical && !horizontal) return false;
  const scale =
    boxes.reduce(
      (sum, box) => sum + Math.min(box.x2 - box.x1, box.y2 - box.y1),
      0,
    ) / boxes.length;
  const startDelta = vertical
    ? Math.abs(leftBox.y1 - rightBox.y1)
    : Math.abs(leftBox.x1 - rightBox.x1);
  const crossGap = axisGap(leftBox, rightBox, vertical ? "x" : "y");
  return startDelta <= scale * 0.8 && crossGap <= scale * 0.8;
}

/** @param {CandidateLike} candidate @returns {Box|null} */
function readBox(candidate) {
  const nested = isRecord(candidate.bbox) ? candidate.bbox : null;
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

module.exports = {
  buildPaddleClassifierRecoveryRelations,
  canRecoverCompleteTwoCandidatePaddleGroup,
  readCompleteTwoCandidatePaddleClassifierSplit,
};
