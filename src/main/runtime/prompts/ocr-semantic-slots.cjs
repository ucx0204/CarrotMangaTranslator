// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").OcrHint} OcrHint */
/** @typedef {OcrHint & { outputSlot?: "merged_semantic_group"; fragmentHints?: OcrHint[] }} PromptOcrHint */

const { readPositiveInteger } = require("./common.cjs");
const { sanitizeOcrGroupId } = require("./ocr-groups.cjs");

/**
 * Project high-confidence groups from the shared semantic OCR path as one prompt
 * output slot. The original hints stay untouched in the request summary so
 * downstream geometry locks can either accept the union or recover individual
 * child boxes when Image 1 proves that an OCR group was wrong.
 *
 * @param {OcrHint[]} hints
 * @param {PromptOptions} options
 * @returns {PromptOcrHint[]}
 */
function projectSemanticGroupOutputSlots(hints, options) {
  if (!shouldProjectSemanticGroupOutputSlots(options)) {
    return hints;
  }

  /** @type {Map<string, OcrHint[]>} */
  const groups = new Map();
  for (const hint of hints) {
    const groupId = sanitizeOcrGroupId(hint.groupId);
    if (!groupId) continue;
    const group = groups.get(groupId) || [];
    group.push(hint);
    groups.set(groupId, group);
  }

  /** @type {Map<string, PromptOcrHint>} */
  const projectedByGroup = new Map();
  const invalidSemanticGroupIds = new Set();
  for (const [groupId, members] of groups) {
    const ordered = validateSemanticGroupMembers(members);
    if (!ordered) {
      if (members.some((hint) => hint.semanticGroup === true)) {
        invalidSemanticGroupIds.add(groupId);
      }
      continue;
    }
    const boxes = /** @type {import("./prompt-types").PromptBox[]} */ (
      ordered.map(readHintBox)
    );
    const representative = ordered[0];
    projectedByGroup.set(groupId, {
      ...representative,
      id: readPositiveInteger(representative.id),
      label: "ocr_textgroup",
      x1: Math.min(...boxes.map((box) => box.x1)),
      y1: Math.min(...boxes.map((box) => box.y1)),
      x2: Math.max(...boxes.map((box) => box.x2)),
      y2: Math.max(...boxes.map((box) => box.y2)),
      // Keep fragment strings only in the structured evidence array below.
      // A joined top-level OCR string made small models copy our visual
      // separator into the final Japanese and Korean text.
      ocrText: "",
      groupId,
      orderInGroup: 1,
      rolePrior: "ordinary_mergeable",
      containerType: "same_text_container",
      semanticGroup: true,
      outputSlot: "merged_semantic_group",
      fragmentHints: ordered,
    });
  }

  /** @type {PromptOcrHint[]} */
  const projected = [];
  const emittedGroups = new Set();
  for (const hint of hints) {
    const groupId = sanitizeOcrGroupId(hint.groupId);
    const groupSlot = projectedByGroup.get(groupId);
    if (!groupSlot) {
      projected.push(
        invalidSemanticGroupIds.has(groupId)
          ? stripSemanticGroupPromptMetadata(hint)
          : hint,
      );
      continue;
    }
    if (!emittedGroups.has(groupId)) {
      projected.push(groupSlot);
      emittedGroups.add(groupId);
    }
  }
  return projected;
}

/** @param {PromptOptions} options @returns {boolean} */
function shouldProjectSemanticGroupOutputSlots(options) {
  return (
    !options.keepBlocksMode &&
    String(options.ocrMergeMode ?? "")
      .trim()
      .toLowerCase() === "semantic"
  );
}

/** @param {OcrHint} hint @returns {PromptOcrHint} */
function stripSemanticGroupPromptMetadata(hint) {
  const copy = { ...hint };
  delete copy.groupId;
  delete copy.orderInGroup;
  delete copy.groupSize;
  delete copy.rolePrior;
  delete copy.containerType;
  delete copy.semanticGroup;
  return copy;
}

/**
 * @param {OcrHint[]} members
 * @returns {OcrHint[] | null}
 */
function validateSemanticGroupMembers(members) {
  if (members.length < 2) return null;
  const ids = members.map((hint) => readPositiveInteger(hint.id));
  const orders = members.map((hint) => readPositiveInteger(hint.orderInGroup));
  const sizes = members.map((hint) => readPositiveInteger(hint.groupSize));
  if (
    members.some(
      (hint) =>
        hint.semanticGroup !== true ||
        hint.rolePrior !== "ordinary_mergeable" ||
        hint.containerType !== "same_text_container" ||
        !readHintBox(hint),
    ) ||
    ids.some((id) => !id) ||
    orders.some((order) => !order) ||
    sizes.some((size) => size !== members.length) ||
    new Set(ids).size !== ids.length ||
    new Set(orders).size !== orders.length ||
    orders
      .slice()
      .sort(
        (left, right) =>
          /** @type {number} */ (left) - /** @type {number} */ (right),
      )
      .some((order, index) => order !== index + 1)
  ) {
    return null;
  }
  return members
    .slice()
    .sort(
      (left, right) =>
        /** @type {number} */ (readPositiveInteger(left.orderInGroup)) -
          /** @type {number} */ (readPositiveInteger(right.orderInGroup)) ||
        /** @type {number} */ (readPositiveInteger(left.id)) -
          /** @type {number} */ (readPositiveInteger(right.id)),
    );
}

/** @param {OcrHint} hint @returns {import("./prompt-types").PromptBox | null} */
function readHintBox(hint) {
  const box = {
    x1: Number(hint?.x1),
    y1: Number(hint?.y1),
    x2: Number(hint?.x2),
    y2: Number(hint?.y2),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

module.exports = {
  projectSemanticGroupOutputSlots,
};
