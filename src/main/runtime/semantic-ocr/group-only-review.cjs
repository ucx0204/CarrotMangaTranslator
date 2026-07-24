// @ts-check

const { readOcrCandidateText } = require("../prompts/ocr-text.cjs");
const { isRecord, semanticContractError } = require("./values.cjs");
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
  GROUP_ONLY_REVIEW_VERSION,
  assertNoDuplicateKeys,
  describeError,
  exactKeys,
  fail,
  integerArray,
  isPlan,
  normalizeEnvelope,
  normalizeFragments,
  optionalBox,
  optionalString,
  pixelBox,
  positive,
  record,
  toCrop1000,
  tupleBox,
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
/** @typedef {import("./group-only-review-types").HintAssignment} HintAssignment */

/**
 * candidates/hints is the canonical raw Paddle-hint array in exact model and
 * reading order. Original Paddle evidence is read only from sidecar fields
 * paddleGroupId/paddleOrder, never from a final groupId.
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
  const stabilized = attachMostlyContainedRubyLabels(
    plan,
    separateWeakDiagonalFragmentMerges(plan, labels),
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
  const attached = attachMostlyContainedRubyLabels(plan, labels);
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
  const groups = ordered.map(([modelGroup, members], index) => {
    const body = members.filter((item) => item.role === "body");
    const ruby = members.filter((item) => item.role === "ruby");
    if (!body.length) fail("ruby-only", `Group ${modelGroup} has no body.`);
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
 * Applies crop results in crop/group order and issues page-global G001..Gnnn.
 * @param {Record<string,unknown>[]} pageHints
 * @param {ReviewProjection[]} cropResults
 * @param {{validatedGroupOnlyReview?:boolean}} [options]
 */
function applyReviewedGroupsToHints(pageHints, cropResults, options = {}) {
  if (!Array.isArray(pageHints) || !Array.isArray(cropResults))
    fail("apply-input", "Hints and crop results must be arrays.");
  const hintById = /** @type {Map<number,Record<string,unknown>>} */ (
    new Map()
  );
  pageHints.forEach((hint, index) => {
    const raw = record(hint, `page hint ${index + 1}`);
    const id = positive(raw.id);
    if (!id || hintById.has(id))
      fail("apply-hint-id", "Page hint ids must be unique.");
    hintById.set(id, raw);
  });
  const assignment = /** @type {Map<number,HintAssignment>} */ (new Map());
  let groupNumber = 0;
  for (const result of cropResults) {
    for (const rawGroup of result.groups) {
      const group = record(rawGroup, "reviewed group");
      const ids = integerArray(group.candidateIds, "candidateIds");
      const body = new Set(
        integerArray(group.bodyCandidateIds, "bodyCandidateIds"),
      );
      const ruby = new Set(
        integerArray(group.rubyCandidateIds, "rubyCandidateIds", true),
      );
      if (!body.size || ids.length !== body.size + ruby.size)
        fail("apply-group", "Reviewed group partition is invalid.");
      groupNumber += 1;
      const groupId = `G${String(groupNumber).padStart(3, "0")}`;
      ids.forEach((id, index) => {
        const role = body.has(id) ? "body" : ruby.has(id) ? "ruby" : "";
        if (!role || !hintById.has(id) || assignment.has(id))
          fail("apply-partition", `Candidate ${id} is missing or duplicated.`);
        assignment.set(id, {
          groupId,
          orderInGroup: index + 1,
          groupSize: ids.length,
          reviewRole: role,
        });
      });
    }
  }
  if (assignment.size !== hintById.size)
    fail(
      "apply-coverage",
      "Crop results must cover every page hint exactly once.",
    );
  const hints = pageHints.map((raw) => {
    const hint = { ...raw };
    delete hint.groupId;
    delete hint.orderInGroup;
    delete hint.groupSize;
    delete hint.semanticGroup;
    delete hint.rolePrior;
    delete hint.containerType;
    const id = positive(hint.id);
    if (!id) fail("apply-hint-id", "Final hint id is invalid.");
    const meta = assignment.get(id);
    if (!meta) fail("apply-coverage", "Missing final hint assignment.");
    hint.reviewRole = meta.reviewRole;
    if (meta.groupSize > 1)
      Object.assign(hint, {
        groupId: meta.groupId,
        orderInGroup: meta.orderInGroup,
        groupSize: meta.groupSize,
        semanticGroup: true,
        rolePrior: "ordinary_mergeable",
        containerType: "same_text_container",
      });
    return hint;
  });
  return {
    hints,
    groupOnlyReviewVersion: GROUP_ONLY_REVIEW_VERSION,
    validatedGroupOnlyReview:
      options.validatedGroupOnlyReview ??
      cropResults.every((result) => result.source !== "upstream-fallback"),
    reviewedGroupCount: groupNumber,
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
  try {
    const response = await requestReview({
      case: reviewCase,
      region,
      candidateOrder: [...plan.candidateOrder],
      systemPrompt: buildGroupOnlyReviewSystemPrompt(),
      prompt: buildGroupOnlyReviewPrompt(plan),
      responseFormat: buildGroupOnlyReviewResponseFormat(
        plan.candidates.length,
      ),
    });
    const { outputText, rawResponse } = readReviewResponse(response);
    if (!outputText)
      fail("empty-response", "Group-only review returned no JSON.");
    return {
      status: "reviewed",
      usedFallback: false,
      requestSkipped: false,
      ...parseGroupOnlyReviewResponse(outputText, plan),
      rawResponse,
    };
  } catch (error) {
    if (isReviewAbort(error)) throw error;
    if (!isExpectedGroupOnlyReviewFailure(error)) throw error;
    return {
      status: "fallback",
      usedFallback: true,
      requestSkipped: false,
      ...buildGroupOnlyReviewFallback(plan),
      rawResponse: null,
      fallbackError: describeError(error),
    };
  }
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
