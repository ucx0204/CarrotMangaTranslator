// @ts-check

const { semanticContractError } = require("./values.cjs");
const {
  applyReviewedGroupsToHints,
} = require("./group-only-review-application.cjs");
const {
  mergeAdjacentVerticalRubyColumns,
} = require("./group-only-review-adjacent-columns.cjs");
const { buildGroupOnlyReviewPlan } = require("./group-only-review-plan.cjs");
const {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  GROUP_ONLY_REVIEW_ROLES,
  buildGroupOnlyReviewPromptFromPlan,
  buildGroupOnlyReviewResponseFormat,
  buildGroupOnlyReviewSystemPrompt,
} = require("./group-only-review-prompts.cjs");
const {
  attachMostlyContainedRubyLabels,
  separateWeakDiagonalFragmentMerges,
} = require("./group-only-review-stabilization.cjs");
const {
  mergeStrongLineageFragmentSplits,
} = require("./group-only-review-lineage-stabilization.cjs");
const {
  orderReviewCandidatesByGeometry,
} = require("./group-only-review-reading-order.cjs");
const {
  requiresRelationFreeRoleBaseline,
} = require("./group-only-review-role-policy.cjs");
const {
  GROUP_ONLY_REVIEW_VERSION,
  assertNoDuplicateKeys,
  describeError,
  exactKeys,
  fail,
  isPlan,
  normalizeEnvelope,
  record,
  unionBoxes,
  validateLabels,
} = require("./group-only-review-values.cjs");
const { isExpectedGroupOnlyReviewFailure } = require("./review-errors.cjs");

/** @typedef {import("./group-only-review-types").ReviewRole} ReviewRole */
/** @typedef {import("./group-only-review-types").ReviewSource} ReviewSource */
/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */
/** @typedef {import("./group-only-review-types").ReviewProjection} ReviewProjection */
/** @typedef {import("./group-only-review-types").ReviewResult} ReviewResult */
/** @param {ReviewPlan | Record<string,unknown>} value @param {Record<string,unknown>} [region] */
function buildGroupOnlyReviewPrompt(value, region = {}) {
  const plan = isPlan(value) ? value : buildGroupOnlyReviewPlan(value, region);
  return buildGroupOnlyReviewPromptFromPlan(plan);
}

/** @param {string} rawText @param {ReviewPlan} plan @returns {ReviewProjection} */
function parseGroupOnlyReviewResponse(rawText, plan) {
  if (!isPlan(plan)) fail("plan", "A validated group-only plan is required.");
  const text = normalizeEnvelope(rawText);
  assertNoDuplicateKeys(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw semanticContractError(
      "group-only-review-json",
      "Invalid group-only JSON.",
      { cause: error },
    );
  }
  const response = record(parsed, "response");
  exactKeys(response, ["labels"], "response");
  if (
    !Array.isArray(response.labels) ||
    response.labels.length !== plan.candidates.length
  ) {
    fail(
      "label-count",
      `Exactly ${plan.candidates.length} labels are required.`,
    );
  }
  const labels = response.labels.map((value, index) => {
    const label = record(value, `label ${index + 1}`);
    exactKeys(label, ["group", "role"], `label ${index + 1}`);
    const group = Number(label.group);
    if (
      !Number.isInteger(label.group) ||
      group < 1 ||
      group > plan.candidates.length
    ) {
      fail("group", `Invalid group at label ${index + 1}.`);
    }
    if (!GROUP_ONLY_REVIEW_ROLES.includes(String(label.role)))
      fail("role", `Invalid role at label ${index + 1}.`);
    return { group, role: /** @type {ReviewRole} */ (label.role) };
  });
  validateLabels(plan, labels);
  const stabilized = mergeAdjacentVerticalRubyColumns(
    plan,
    attachMostlyContainedRubyLabels(
      plan,
      mergeStrongLineageFragmentSplits(
        plan,
        separateWeakDiagonalFragmentMerges(plan, labels),
      ),
    ),
  );
  validateLabels(plan, stabilized);
  return projectGroupOnlyReviewLabels(plan, stabilized, "model");
}

/** @param {ReviewPlan} plan @returns {ReviewProjection} */
function buildGroupOnlyReviewFallback(plan) {
  if (!isPlan(plan)) fail("plan", "A validated group-only plan is required.");
  const groupById = /** @type {Map<number,number>} */ (new Map());
  plan.upstreamFragments.forEach((fragment, index) => {
    fragment.candidateIds.forEach((id) => groupById.set(id, index + 1));
  });
  const labels = plan.candidates.map((item) => ({
    group: Number(groupById.get(item.id)),
    role: /** @type {"body"} */ ("body"),
  }));
  const attached = mergeAdjacentVerticalRubyColumns(
    plan,
    attachMostlyContainedRubyLabels(
      plan,
      mergeStrongLineageFragmentSplits(plan, labels),
    ),
  );
  validateLabels(plan, attached);
  return projectGroupOnlyReviewLabels(plan, attached, "upstream-fallback");
}

/** @param {ReviewPlan} plan @param {ReviewLabel[]} labels @param {ReviewSource} source @returns {ReviewProjection} */
function projectGroupOnlyReviewLabels(plan, labels, source) {
  if (labels.length !== plan.candidates.length)
    fail("label-count", "Label count does not match candidates.");
  const buckets =
    /** @type {Map<number,Array<{candidate:ReviewCandidate;role:ReviewRole}>>} */ (
      new Map()
    );
  plan.candidates.forEach((candidate, index) => {
    const label = labels[index];
    const members = buckets.get(label.group) ?? [];
    members.push({ candidate, role: label.role });
    buckets.set(label.group, members);
  });
  const ordered = [...buckets].sort(
    (left, right) =>
      Math.min(...left[1].map((item) => item.candidate.id)) -
      Math.min(...right[1].map((item) => item.candidate.id)),
  );
  const upstreamFragmentByCandidateId = new Map();
  plan.upstreamFragments.forEach((fragment, index) => {
    fragment.candidateIds.forEach((id) =>
      upstreamFragmentByCandidateId.set(id, index),
    );
  });
  const groups = ordered.map(([modelGroup, members], index) => {
    const body = members.filter((item) => item.role === "body");
    const ruby = members.filter((item) => item.role === "ruby");
    if (!body.length) fail("ruby-only", `Group ${modelGroup} has no body.`);
    const spansMultipleUpstreamFragments =
      source === "model" &&
      new Set(
        members.map((item) =>
          upstreamFragmentByCandidateId.get(item.candidate.id),
        ),
      ).size > 1;
    if (spansMultipleUpstreamFragments && body.length > 1) {
      const readingOrder = new Map(
        orderReviewCandidatesByGeometry(body.map((item) => item.candidate)).map(
          (candidate, order) => [candidate.id, order],
        ),
      );
      body.sort(
        (left, right) =>
          Number(readingOrder.get(left.candidate.id)) -
          Number(readingOrder.get(right.candidate.id)),
      );
    }
    return {
      localGroupIndex: index + 1,
      modelGroup: source === "model" ? modelGroup : null,
      candidateIds: [...body, ...ruby].map((item) => item.candidate.id),
      bodyCandidateIds: body.map((item) => item.candidate.id),
      rubyCandidateIds: ruby.map((item) => item.candidate.id),
      jp: body.map((item) => item.candidate.text).join(""),
      bbox: unionBoxes(members.map((item) => item.candidate.bbox)),
    };
  });
  return {
    source,
    labels: labels.map((item) => ({ ...item })),
    groups,
    candidateOrder: [...plan.candidateOrder],
  };
}

/**
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} region
 * @param {(request:Record<string,unknown>)=>Promise<string|{outputText:string;rawResponse?:unknown}>} requestReview
 * @returns {Promise<ReviewResult>}
 */
async function reviewGroupOnlyCrop(reviewCase, region, requestReview) {
  const plan = buildGroupOnlyReviewPlan(reviewCase, region);
  if (plan.candidates.length === 1) {
    return {
      status: "singleton",
      usedFallback: false,
      requestSkipped: true,
      requestCount: 0,
      ...projectGroupOnlyReviewLabels(
        plan,
        [{ group: 1, role: "body" }],
        "singleton",
      ),
      rawResponse: null,
    };
  }
  if (typeof requestReview !== "function")
    fail("request", "A request callback is required.");
  const attempts = { count: 0 };
  try {
    const reviewed = await requestReviewedProjection(
      plan,
      reviewCase,
      region,
      requestReview,
      attempts,
    );
    return {
      status: "reviewed",
      usedFallback: false,
      requestSkipped: false,
      requestCount: attempts.count,
      ...reviewed.projection,
      rawResponse: reviewed.rawResponse,
    };
  } catch (error) {
    if (isReviewAbort(error)) throw error;
    if (!isExpectedGroupOnlyReviewFailure(error)) throw error;
    return {
      status: "fallback",
      usedFallback: true,
      requestSkipped: false,
      requestCount: attempts.count,
      ...buildGroupOnlyReviewFallback(plan),
      rawResponse: null,
      fallbackError: describeError(error),
    };
  }
}

/**
 * Auxiliary detector relations may change only grouping. Resolve roles from
 * the same crop without that relation, then combine those roles with the
 * relation-aware group labels.
 *
 * @param {ReviewPlan} plan
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} region
 * @param {(request:Record<string,unknown>)=>Promise<string|{outputText:string;rawResponse?:unknown}>} requestReview
 * @param {{count:number}} attempts
 */
async function requestReviewedProjection(
  plan,
  reviewCase,
  region,
  requestReview,
  attempts,
) {
  const relationAware = hasAnimeTextRelation(plan);
  const grouping = await requestSingleProjection(
    plan,
    reviewCase,
    region,
    requestReview,
    attempts,
    relationAware ? "relation-aware-grouping" : "grouping-and-roles",
  );
  if (
    !relationAware ||
    !requiresRelationFreeRoleBaseline(plan, grouping.projection)
  ) {
    return grouping;
  }
  const roleBaseline = await requestRelationFreeRoleBaseline(
    reviewCase,
    region,
    requestReview,
    attempts,
  );
  return {
    projection: combineGroupingWithRoles(
      plan,
      grouping.projection,
      roleBaseline.projection,
    ),
    rawResponse: {
      grouping: grouping.rawResponse,
      roleBaseline: roleBaseline.rawResponse,
    },
  };
}

/**
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} region
 * @param {(request:Record<string,unknown>)=>Promise<string|{outputText:string;rawResponse?:unknown}>} requestReview
 * @param {{count:number}} attempts
 */
function requestRelationFreeRoleBaseline(
  reviewCase,
  region,
  requestReview,
  attempts,
) {
  const relationFreeCase = { ...reviewCase };
  delete relationFreeCase.spatialRelations;
  return requestSingleProjection(
    buildGroupOnlyReviewPlan(relationFreeCase, region),
    relationFreeCase,
    region,
    requestReview,
    attempts,
    "relation-free-role-baseline",
  );
}

/**
 * @param {ReviewPlan} plan
 * @param {Record<string,unknown>} reviewCase
 * @param {Record<string,unknown>} region
 * @param {(request:Record<string,unknown>)=>Promise<string|{outputText:string;rawResponse?:unknown}>} requestReview
 * @param {{count:number}} attempts
 * @param {string} reviewPurpose
 */
async function requestSingleProjection(
  plan,
  reviewCase,
  region,
  requestReview,
  attempts,
  reviewPurpose,
) {
  attempts.count += 1;
  const response = await requestReview({
    case: reviewCase,
    region,
    reviewPurpose,
    candidateOrder: [...plan.candidateOrder],
    systemPrompt: buildGroupOnlyReviewSystemPrompt(),
    prompt: buildGroupOnlyReviewPrompt(plan),
    responseFormat: buildGroupOnlyReviewResponseFormat(plan.candidates.length),
  });
  const { outputText, rawResponse } = readReviewResponse(response);
  if (!outputText)
    fail("empty-response", "Group-only review returned no JSON.");
  return {
    projection: parseGroupOnlyReviewResponse(outputText, plan),
    rawResponse,
  };
}

/**
 * @param {ReviewPlan} plan
 * @param {ReviewProjection} grouping
 * @param {ReviewProjection} roleBaseline
 */
function combineGroupingWithRoles(plan, grouping, roleBaseline) {
  if (
    JSON.stringify(grouping.candidateOrder) !==
      JSON.stringify(plan.candidateOrder) ||
    JSON.stringify(roleBaseline.candidateOrder) !==
      JSON.stringify(plan.candidateOrder)
  ) {
    fail("candidate-order", "Review projections must use the same candidates.");
  }
  const labels = grouping.labels.map((label, index) => ({
    group: label.group,
    role: roleBaseline.labels[index].role,
  }));
  validateLabels(plan, labels);
  return projectGroupOnlyReviewLabels(plan, labels, "model");
}

/** @param {ReviewPlan} plan */
function hasAnimeTextRelation(plan) {
  const shared = plan.spatialRelations.sharedAnimeTextRegions;
  const distinct = plan.spatialRelations.distinctAnimeTextRegionBarriers;
  const recoveries = plan.spatialRelations.paddleClassifierRecoveries;
  return (
    (Array.isArray(shared) && shared.length > 0) ||
    (Array.isArray(distinct) && distinct.length > 0) ||
    (Array.isArray(recoveries) && recoveries.length > 0)
  );
}

/** @param {string|{outputText?:string;rawResponse?:unknown}|null|undefined} response */
function readReviewResponse(response) {
  if (typeof response === "string")
    return { outputText: response, rawResponse: response };
  if (!response) return { outputText: "", rawResponse: response };
  return {
    outputText: response.outputText,
    rawResponse: response.rawResponse ?? response,
  };
}

/** @param {unknown} error */
function isReviewAbort(error) {
  const candidate = /** @type {Error & {code?:unknown}} */ (error);
  return (
    error instanceof Error &&
    (error.name === "AbortError" || candidate.code === "ABORT_ERR")
  );
}

module.exports = {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  GROUP_ONLY_REVIEW_VERSION,
  applyReviewedGroupsToHints,
  buildGroupOnlyReviewFallback,
  buildGroupOnlyReviewPlan,
  buildGroupOnlyReviewPrompt,
  buildGroupOnlyReviewResponseFormat,
  buildGroupOnlyReviewSystemPrompt,
  parseGroupOnlyReviewResponse,
  reviewGroupOnlyCrop,
};
