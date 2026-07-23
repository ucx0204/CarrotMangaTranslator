// @ts-check
/**
 * @typedef {{ x1: number; y1: number; x2: number; y2: number }} OcrBox
 * @typedef {OcrBox & { label?: string; ocrText?: string; groupId?: string; orderInGroup?: number; rolePrior?: string; containerType?: string; [key: string]: unknown }} OcrHint
 * @typedef {{ imageWidth?: unknown; imageHeight?: unknown; sourceLanguage?: unknown; [key: string]: unknown }} OcrHintOptions
 * @typedef {{ hint: OcrHint; index: number; eligible: boolean }} GroupItem
 */
const {
  readOcrCandidateText,
  readPositiveInteger,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
} = require("../simple-page-prompts.cjs");
const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");

/**
 * @param {OcrHint[]} hints
 * @param {OcrHintOptions} [options]
 * @returns {OcrHint[]}
 */
function attachOcrGroupingHints(hints, options = {}) {
  if (!Array.isArray(hints) || hints.length < 2) {
    return Array.isArray(hints) ? hints : [];
  }
  if (resolvePromptLanguageProfile(options).sourceBaseCode !== "ja") {
    return hints;
  }
  const nextGroupNumber = attachGroups(hints, options, {
    startGroupNumber: nextAvailableGroupNumber(hints),
    isEligible: (hint) =>
      !hint.groupId && isAdjacentTextContainerCandidate(hint),
    isCompatible: areAdjacentTextContainerCompatible,
    rolePrior: "ordinary_mergeable",
    containerType: "same_text_container",
  });
  attachGroups(hints, options, {
    startGroupNumber: nextGroupNumber,
    isEligible: (hint) => !hint.groupId && isSemanticGroupingCandidate(hint),
    isCompatible: areGroupingCompatible,
    rolePrior: "ordinary_soft",
    containerType: "possible_continuing_text",
  });
  return hints;
}

/** @param {OcrHint[]} hints */
function nextAvailableGroupNumber(hints) {
  let highest = 0;
  for (const hint of hints) {
    const match = /^G(\d{3,4})$/.exec(
      String(hint?.groupId ?? "").toUpperCase(),
    );
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest + 1;
}

/**
 * @param {OcrHint[]} hints
 * @param {OcrHintOptions} options
 * @param {{ startGroupNumber: number; isEligible: (hint: OcrHint) => boolean; isCompatible: (left: OcrHint, right: OcrHint, options: OcrHintOptions) => boolean; rolePrior: string; containerType: string }} policy
 */
function attachGroups(hints, options, policy) {
  const items = hints.map((hint, index) => ({
    hint,
    index,
    eligible: policy.isEligible(hint),
  }));
  const groups = collectCompatibleHintGroups(items, (left, right) =>
    policy.isCompatible(left, right, options),
  );
  let groupNumber = policy.startGroupNumber;
  for (const group of groups.values()) {
    if (!isAcceptedGroupSize(group)) {
      continue;
    }
    attachGroupMetadata(group, groupNumber, policy);
    groupNumber += 1;
  }
  return groupNumber;
}

/** @param {GroupItem[]} group */
function isAcceptedGroupSize(group) {
  return group.length >= 2 && group.length <= 4;
}

/**
 * @param {GroupItem[]} group
 * @param {number} groupNumber
 * @param {{ rolePrior: string; containerType: string }} policy
 */
function attachGroupMetadata(group, groupNumber, policy) {
  group.sort((left, right) =>
    compareJapaneseReadingOrder(left.hint, right.hint),
  );
  const groupId = `G${String(groupNumber).padStart(3, "0")}`;
  group.forEach((item, index) => {
    item.hint.groupId = groupId;
    item.hint.orderInGroup = index + 1;
    item.hint.rolePrior = policy.rolePrior;
    item.hint.containerType = policy.containerType;
  });
}

/**
 * @param {GroupItem[]} items
 * @param {(left: OcrHint, right: OcrHint) => boolean} isCompatible
 * @returns {Map<number, GroupItem[]>}
 */
function collectCompatibleHintGroups(items, isCompatible) {
  const parent = items.map((_, index) => index);
  const find = createRootFinder(parent);
  for (let left = 0; left < items.length; left += 1) {
    connectCompatibleItems(items, left, parent, find, isCompatible);
  }
  return collectGroupsByRoot(items, find);
}

/** @param {number[]} parent */
function createRootFinder(parent) {
  /** @param {number} index */
  return function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
}

/**
 * @param {GroupItem[]} items
 * @param {number} left
 * @param {number[]} parent
 * @param {(index: number) => number} find
 * @param {(left: OcrHint, right: OcrHint) => boolean} isCompatible
 */
function connectCompatibleItems(items, left, parent, find, isCompatible) {
  if (!items[left].eligible) {
    return;
  }
  for (let right = left + 1; right < items.length; right += 1) {
    if (!items[right].eligible) {
      continue;
    }
    if (isCompatible(items[left].hint, items[right].hint)) {
      parent[find(right)] = find(left);
    }
  }
}

/**
 * @param {GroupItem[]} items
 * @param {(index: number) => number} find
 */
function collectGroupsByRoot(items, find) {
  const groups = new Map();
  for (const item of items) {
    if (!item.eligible) {
      continue;
    }
    const root = find(item.index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  }
  return groups;
}

/** @param {OcrHint} hint */
function isAdjacentTextContainerCandidate(hint) {
  const label = sanitizeHintLabel(hint?.label);
  const text = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  if (!text || !hasJapaneseTextEvidence(text) || !isTallBox(hint)) {
    return false;
  }
  if (!label.includes("textline") && !label.includes("vertical")) {
    return false;
  }
  const length = [...text.replace(/\s+/g, "")].filter((char) =>
    hasJapaneseTextEvidence(char),
  ).length;
  return length >= 2 && length <= 40;
}

/**
 * @param {OcrHint} left
 * @param {OcrHint} right
 * @param {OcrHintOptions} [options]
 */
function areAdjacentTextContainerCompatible(left, right, options = {}) {
  const pair = readBoxPair(left, right);
  if (!pair) {
    return false;
  }
  const { leftBox, rightBox, leftSize, rightSize } = pair;
  const heightRatio =
    Math.min(leftSize.height, rightSize.height) /
    Math.max(leftSize.height, rightSize.height);
  if (heightRatio < 0.55 || verticalOverlapRatio(pair) < 0.62) {
    return false;
  }
  const xGap = Math.max(
    0,
    Math.max(leftBox.x1, rightBox.x1) - Math.min(leftBox.x2, rightBox.x2),
  );
  if (xGap > Math.max(12, Math.min(leftSize.width, rightSize.width) * 0.45)) {
    return false;
  }
  const pageWidth =
    readPositiveInteger(options.imageWidth) ||
    Math.max(leftBox.x2, rightBox.x2);
  return (
    !pageWidth || centerDistance(leftBox, rightBox, "x") <= pageWidth * 0.25
  );
}

/** @param {OcrHint} hint */
function isSemanticGroupingCandidate(hint) {
  const label = sanitizeHintLabel(hint?.label);
  const text = sanitizeOcrTextForPrompt(readOcrCandidateText(hint));
  if (!text || !hasJapaneseTextEvidence(text) || !hasHiragana(text)) {
    return false;
  }
  if (hasCjkIdeograph(text)) {
    return false;
  }
  const length = text.replace(/[^\u3040-\u309f\u30a0-\u30ff]/g, "").length;
  return (
    length >= 2 &&
    length <= 10 &&
    (label.includes("vertical") || isTallBox(hint))
  );
}

/**
 * @param {OcrHint} left
 * @param {OcrHint} right
 * @param {OcrHintOptions} [options]
 */
function areGroupingCompatible(left, right, options = {}) {
  const pair = readBoxPair(left, right);
  if (!pair) {
    return false;
  }
  const maxHeight = Math.max(pair.leftSize.height, pair.rightSize.height);
  const sameReadingBand =
    verticalOverlapRatio(pair) >= 0.25 ||
    centerDistance(pair.leftBox, pair.rightBox, "y") <= maxHeight * 0.75;
  if (!sameReadingBand) {
    return false;
  }
  const pageWidth =
    readPositiveInteger(options.imageWidth) ||
    Math.max(pair.leftBox.x2, pair.rightBox.x2);
  if (
    pageWidth &&
    centerDistance(pair.leftBox, pair.rightBox, "x") > pageWidth * 0.85
  ) {
    return false;
  }
  const leftArea = pair.leftSize.width * pair.leftSize.height;
  const rightArea = pair.rightSize.width * pair.rightSize.height;
  const areaRatio = leftArea / Math.max(1, rightArea);
  return areaRatio >= 0.15 && areaRatio <= 6.5;
}

/**
 * @param {OcrHint} left
 * @param {OcrHint} right
 */
function readBoxPair(left, right) {
  const leftBox = readHintBox(left);
  const rightBox = readHintBox(right);
  if (!leftBox || !rightBox) {
    return null;
  }
  const leftSize = readPositiveBoxSize(leftBox);
  const rightSize = readPositiveBoxSize(rightBox);
  return leftSize && rightSize
    ? { leftBox, rightBox, leftSize, rightSize }
    : null;
}

/** @param {OcrBox} box */
function readPositiveBoxSize(box) {
  const width = box.x2 - box.x1;
  const height = box.y2 - box.y1;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** @param {{ leftBox: OcrBox; rightBox: OcrBox; leftSize: { width: number; height: number }; rightSize: { width: number; height: number } }} pair */
function verticalOverlapRatio(pair) {
  const overlap = Math.max(
    0,
    Math.min(pair.leftBox.y2, pair.rightBox.y2) -
      Math.max(pair.leftBox.y1, pair.rightBox.y1),
  );
  return overlap / Math.min(pair.leftSize.height, pair.rightSize.height);
}

/** @param {OcrBox} left @param {OcrBox} right @param {"x" | "y"} axis */
function centerDistance(left, right, axis) {
  return Math.abs(centerOf(left)[axis] - centerOf(right)[axis]);
}

/** @param {OcrHint} left @param {OcrHint} right */
function compareJapaneseReadingOrder(left, right) {
  const leftBox = readHintBox(left);
  const rightBox = readHintBox(right);
  if (!leftBox || !rightBox) {
    return 0;
  }
  const leftCenter = centerOf(leftBox);
  const rightCenter = centerOf(rightBox);
  const xDistance = rightCenter.x - leftCenter.x;
  return Math.abs(xDistance) > 12 ? xDistance : leftCenter.y - rightCenter.y;
}

/** @param {unknown} hint */
function readHintBox(hint) {
  const record =
    hint && typeof hint === "object"
      ? /** @type {Record<string, unknown>} */ (hint)
      : {};
  const values = [record.x1, record.y1, record.x2, record.y2].map(Number);
  if (!values.every(Number.isFinite)) {
    return null;
  }
  return {
    x1: Math.min(values[0], values[2]),
    y1: Math.min(values[1], values[3]),
    x2: Math.max(values[0], values[2]),
    y2: Math.max(values[1], values[3]),
  };
}

/** @param {OcrBox} box */
function centerOf(box) {
  return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
}

/** @param {OcrHint} hint */
function isTallBox(hint) {
  const box = readHintBox(hint);
  return Boolean(box && box.y2 - box.y1 > (box.x2 - box.x1) * 1.2);
}

/** @param {unknown} text */
function hasJapaneseTextEvidence(text) {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005]/u.test(
    String(text ?? ""),
  );
}

/** @param {unknown} text */
function hasHiragana(text) {
  return /[\u3040-\u309f]/u.test(String(text ?? ""));
}

/** @param {unknown} text */
function hasCjkIdeograph(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text ?? ""));
}

module.exports = { attachOcrGroupingHints };
