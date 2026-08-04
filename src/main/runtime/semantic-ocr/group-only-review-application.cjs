// @ts-check

const {
  GROUP_ONLY_REVIEW_VERSION,
  fail,
  integerArray,
  positive,
  record,
} = require("./group-only-review-values.cjs");
const {
  stabilizeDeferredRubyAcrossCropAssignments,
} = require("./group-only-review-global-stabilization.cjs");

/** @typedef {import("./group-only-review-types").ReviewProjection} ReviewProjection */
/** @typedef {import("./group-only-review-types").HintAssignment} HintAssignment */

/**
 * Applies crop results in crop/group order and issues page-global G001..Gnnn.
 *
 * @param {Record<string,unknown>[]} pageHints
 * @param {ReviewProjection[]} cropResults
 * @param {{validatedGroupOnlyReview?:boolean}} [options]
 */
function applyReviewedGroupsToHints(pageHints, cropResults, options = {}) {
  if (!Array.isArray(pageHints) || !Array.isArray(cropResults))
    fail("apply-input", "Hints and crop results must be arrays.");
  const hintById = indexPageHints(pageHints);
  const initial = collectAssignments(cropResults, hintById);
  if (initial.assignment.size !== hintById.size)
    fail(
      "apply-coverage",
      "Crop results must cover every page hint exactly once.",
    );
  const { assignment, groupCount } = stabilizeDeferredRubyAcrossCropAssignments(
    pageHints,
    initial.assignment,
    initial.groupCount,
  );
  if (assignment.size !== hintById.size)
    fail(
      "apply-coverage",
      "Crop results must cover every page hint exactly once.",
    );
  return {
    hints: pageHints.map((hint) => applyAssignment(hint, assignment)),
    groupOnlyReviewVersion: GROUP_ONLY_REVIEW_VERSION,
    validatedGroupOnlyReview:
      options.validatedGroupOnlyReview ??
      cropResults.every((result) => result.source !== "upstream-fallback"),
    reviewedGroupCount: groupCount,
  };
}

/** @param {Record<string,unknown>[]} pageHints */
function indexPageHints(pageHints) {
  /** @type {Map<number,Record<string,unknown>>} */
  const hintById = new Map();
  pageHints.forEach((hint, index) => {
    const raw = record(hint, `page hint ${index + 1}`);
    const id = positive(raw.id);
    if (!id || hintById.has(id))
      fail("apply-hint-id", "Page hint ids must be unique.");
    hintById.set(id, raw);
  });
  return hintById;
}

/**
 * @param {ReviewProjection[]} cropResults
 * @param {Map<number,Record<string,unknown>>} hintById
 */
function collectAssignments(cropResults, hintById) {
  /** @type {Map<number,HintAssignment>} */
  const assignment = new Map();
  let groupCount = 0;
  for (const result of cropResults) {
    for (const rawGroup of result.groups) {
      groupCount += 1;
      assignGroup(
        rawGroup,
        `G${String(groupCount).padStart(3, "0")}`,
        hintById,
        assignment,
      );
    }
  }
  return { assignment, groupCount };
}

/**
 * @param {unknown} rawGroup
 * @param {string} groupId
 * @param {Map<number,Record<string,unknown>>} hintById
 * @param {Map<number,HintAssignment>} assignment
 */
function assignGroup(rawGroup, groupId, hintById, assignment) {
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

/**
 * @param {Record<string,unknown>} raw
 * @param {Map<number,HintAssignment>} assignment
 */
function applyAssignment(raw, assignment) {
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
}

module.exports = { applyReviewedGroupsToHints };
