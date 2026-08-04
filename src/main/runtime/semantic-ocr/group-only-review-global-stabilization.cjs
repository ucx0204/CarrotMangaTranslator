// @ts-check

const {
  buildAnimeTextSpatialRelations,
} = require("./anime-text-review-relations.cjs");
const {
  attachDeferredRubyLabels,
} = require("./group-only-review-ruby-deferred.cjs");
const { buildGroupOnlyReviewPlan } = require("./group-only-review-plan.cjs");

/** @typedef {import("./group-only-review-types").HintAssignment} HintAssignment */
/** @typedef {import("./group-only-review-types").ReviewLabel} ReviewLabel */
/** @typedef {import("./group-only-review-types").ReviewPlan} ReviewPlan */

/**
 * Region review is intentionally local, but a tiny ruby and its host can land
 * in adjacent regions. Re-run only the deterministic deferred-ruby stabilizer
 * after every region has a validated page-global assignment. All other groups
 * and their existing member order remain untouched.
 *
 * @param {Record<string,unknown>[]} pageHints
 * @param {Map<number,HintAssignment>} initialAssignment
 * @param {number} initialGroupCount
 */
function stabilizeDeferredRubyAcrossCropAssignments(
  pageHints,
  initialAssignment,
  initialGroupCount,
) {
  const plan = buildOptionalGlobalReviewPlan(pageHints);
  if (!plan) {
    return {
      assignment: initialAssignment,
      groupCount: initialGroupCount,
    };
  }
  const initialLabels = readInitialLabels(plan, initialAssignment);
  const candidateIndexById = new Map(
    plan.candidates.map((candidate, index) => [candidate.id, index]),
  );
  const stabilized = attachDeferredRubyLabels(
    plan,
    initialLabels,
    candidateIndexById,
  );
  if (
    labelsAreEqual(initialLabels, stabilized) ||
    !everyGroupRetainsBody(stabilized)
  ) {
    return {
      assignment: initialAssignment,
      groupCount: initialGroupCount,
    };
  }
  return rebuildAssignments(
    plan,
    initialAssignment,
    stabilized,
    initialGroupCount,
  );
}

/** @param {Record<string,unknown>[]} pageHints @returns {ReviewPlan|null} */
function buildOptionalGlobalReviewPlan(pageHints) {
  if (!pageHints.length) return null;
  const upstreamFragments = readPageFragments(pageHints);
  if (!upstreamFragments) return null;
  return buildGroupOnlyReviewPlan({
    candidates: pageHints,
    candidateOrder: pageHints.map((hint) => Number(hint.id)),
    upstreamFragments,
    spatialRelations: buildAnimeTextSpatialRelations(pageHints),
  });
}

/** @param {Record<string,unknown>[]} pageHints */
function readPageFragments(pageHints) {
  /** @type {Map<string,{fragment:string;status:string;members:Array<{id:number;order:number}>}>} */
  const indexed = new Map();
  for (const [index, hint] of pageHints.entries()) {
    const fragment = readString(hint.reviewFragmentId);
    const status = readString(hint.reviewStatus);
    const id = readPositiveInteger(hint.id);
    if (!fragment || !id || !["confirmed", "deferred"].includes(status ?? ""))
      return null;
    const existing = indexed.get(fragment);
    if (existing && existing.status !== status) return null;
    const record = existing ?? {
      fragment,
      status: /** @type {string} */ (status),
      members: [],
    };
    record.members.push({
      id,
      order: readPositiveInteger(hint.reviewOrder) ?? index + 1,
    });
    indexed.set(fragment, record);
  }
  return [...indexed.values()].map((fragment) => ({
    fragment: fragment.fragment,
    status: fragment.status,
    candidateIds: fragment.members
      .sort((left, right) => left.order - right.order)
      .map((member) => member.id),
  }));
}

/** @param {ReviewPlan} plan @param {Map<number,HintAssignment>} assignment */
function readInitialLabels(plan, assignment) {
  return plan.candidates.map((candidate) => {
    const item = assignment.get(candidate.id);
    if (!item)
      throw new Error(`Missing assignment for candidate ${candidate.id}.`);
    const group = readGlobalGroupNumber(item.groupId);
    if (!group) throw new Error(`Invalid global group ${item.groupId}.`);
    return { group, role: item.reviewRole };
  });
}

/** @param {ReviewLabel[]} left @param {ReviewLabel[]} right */
function labelsAreEqual(left, right) {
  return left.every(
    (label, index) =>
      label.group === right[index]?.group && label.role === right[index]?.role,
  );
}

/** @param {ReviewLabel[]} labels */
function everyGroupRetainsBody(labels) {
  const groups = new Set(labels.map((label) => label.group));
  return [...groups].every((group) =>
    labels.some((label) => label.group === group && label.role === "body"),
  );
}

/** @param {ReviewPlan} plan @param {Map<number,HintAssignment>} initialAssignment @param {ReviewLabel[]} labels @param {number} initialGroupCount */
function rebuildAssignments(
  plan,
  initialAssignment,
  labels,
  initialGroupCount,
) {
  /** @type {Map<number,HintAssignment>} */
  const assignment = new Map();
  let groupCount = 0;
  for (let target = 1; target <= initialGroupCount; target += 1) {
    const members = readStabilizedGroupMembers(
      plan,
      initialAssignment,
      labels,
      target,
    );
    if (!members.length) continue;
    groupCount += 1;
    const groupId = `G${String(groupCount).padStart(3, "0")}`;
    members.forEach(({ id, role }, index) =>
      assignment.set(id, {
        groupId,
        orderInGroup: index + 1,
        groupSize: members.length,
        reviewRole: role,
      }),
    );
  }
  if (assignment.size !== initialAssignment.size)
    throw new Error("Global ruby stabilization lost a candidate assignment.");
  return { assignment, groupCount };
}

/** @param {ReviewPlan} plan @param {Map<number,HintAssignment>} initialAssignment @param {ReviewLabel[]} labels @param {number} target */
function readStabilizedGroupMembers(plan, initialAssignment, labels, target) {
  const members = plan.candidates.flatMap((candidate, index) =>
    labels[index].group === target
      ? [
          {
            id: candidate.id,
            role: labels[index].role,
            initial: /** @type {HintAssignment} */ (
              initialAssignment.get(candidate.id)
            ),
          },
        ]
      : [],
  );
  const retained = members
    .filter(
      (member) => readGlobalGroupNumber(member.initial.groupId) === target,
    )
    .sort(
      (left, right) => left.initial.orderInGroup - right.initial.orderInGroup,
    );
  const moved = members.filter(
    (member) => readGlobalGroupNumber(member.initial.groupId) !== target,
  );
  return [...retained, ...moved].map(({ id, role }) => ({ id, role }));
}

/** @param {string} groupId */
function readGlobalGroupNumber(groupId) {
  const match = /^G(\d+)$/.exec(groupId);
  return match ? readPositiveInteger(match[1]) : null;
}

/** @param {unknown} value */
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {unknown} value */
function readPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

module.exports = { stabilizeDeferredRubyAcrossCropAssignments };
