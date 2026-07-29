// @ts-check

const {
  FORBIDDEN_DEFERRED_HOST_REASONS,
} = require("./group-review-crop-contract.cjs");
const {
  axisOverlapRatio,
  boxIntersectionArea,
  boxOrientation,
  clamp,
  createNumericDisjointSet,
  unionBoxes,
} = require("./group-review-crop-geometry.cjs");

/** @typedef {import("./group-review-crop-types").PageBox} PageBox */
/** @typedef {import("./group-review-crop-types").ReviewFragment} ReviewFragment */
/** @typedef {import("./group-review-crop-types").InternalRegion} InternalRegion */
/** @typedef {{axis:"x"|"y";startKey:"x1"|"y1";endKey:"x2"|"y2";before:InternalRegion;after:InternalRegion;xFraction:number;yFraction:number}} OverlapContext */

/**
 * @param {ReviewFragment[]} fragments
 * @param {string[]} reasons
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {InternalRegion}
 */
function createPaddedRegion(fragments, reasons, pageWidth, pageHeight) {
  if (fragments.length === 0) {
    throw new Error("Cannot create an empty group review crop region.");
  }
  const contentBbox = unionBoxes(
    fragments.flatMap((fragment) =>
      fragment.candidates.map((candidate) => candidate.bbox),
    ),
  );
  const padding = resolveRegionPadding(contentBbox, fragments);
  return {
    reasons: [...new Set(reasons)].sort(),
    fragments: [...fragments].sort((left, right) =>
      left.fragmentId.localeCompare(right.fragmentId),
    ),
    contentBbox,
    cropBbox: {
      x1: Math.max(0, contentBbox.x1 - padding.x),
      y1: Math.max(0, contentBbox.y1 - padding.y),
      x2: Math.min(pageWidth, contentBbox.x2 + padding.x),
      y2: Math.min(pageHeight, contentBbox.y2 + padding.y),
    },
    padding,
  };
}

/** @param {PageBox} contentBbox @param {ReviewFragment[]} fragments */
function resolveRegionPadding(contentBbox, fragments) {
  const width = Math.max(1, contentBbox.x2 - contentBbox.x1);
  const height = Math.max(1, contentBbox.y2 - contentBbox.y1);
  const hasConfirmed = fragments.some(
    (fragment) => fragment.status === "confirmed",
  );
  const orientation = boxOrientation(contentBbox);
  if (hasConfirmed && orientation === "vertical") {
    return {
      x: clamp(Math.round(width * 0.22), 18, 48),
      y: clamp(Math.round(height * 0.06), 10, 28),
    };
  }
  if (hasConfirmed && orientation === "horizontal") {
    return {
      x: clamp(Math.round(width * 0.06), 10, 28),
      y: clamp(Math.round(height * 0.22), 18, 48),
    };
  }
  const ratio = hasConfirmed ? 0.12 : 0.18;
  const minimum = hasConfirmed ? 14 : 16;
  const maximum = hasConfirmed ? 36 : 56;
  return {
    x: clamp(Math.round(width * ratio), minimum, maximum),
    y: clamp(Math.round(height * ratio), minimum, maximum),
  };
}

/**
 * Divide padding at whitespace, clip narrow content seams, and merge only
 * genuine remaining content collisions.
 *
 * @param {InternalRegion[]} initialRegions
 * @returns {InternalRegion[]}
 */
function resolveCropOverlaps(initialRegions) {
  let regions = initialRegions;
  const maximumIterations = Math.max(1, regions.length * 3);
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    clipPaddingOverlaps(regions);
    const changed = resolveContentOverlaps(regions);
    clipPaddingOverlaps(regions);
    const conflicts = collectCropConflicts(regions);
    if (conflicts.length === 0) return regions;
    const merged = mergeConflictComponents(regions, conflicts);
    if (merged.length === regions.length && !changed) break;
    regions = merged;
  }
  clipPaddingOverlaps(regions);
  if (collectCropConflicts(regions).length > 0) {
    throw new Error("Group review crop rectangles could not be separated.");
  }
  return regions;
}

/** @param {InternalRegion[]} regions */
function resolveContentOverlaps(regions) {
  let changed = false;
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < regions.length;
      rightIndex += 1
    ) {
      changed =
        resolveContentOverlap(regions[leftIndex], regions[rightIndex]) ||
        changed;
    }
  }
  return changed;
}

/** @param {InternalRegion} left @param {InternalRegion} right */
function resolveContentOverlap(left, right) {
  if (boxIntersectionArea(left.cropBbox, right.cropBbox) <= 0) return false;
  const context = buildOverlapContext(left, right);
  if (Math.min(context.xFraction, context.yFraction) <= 0.04) {
    return clipNarrowContentSeam(context);
  }
  return clipDisplayContent(context, left, right);
}

/** @param {InternalRegion} left @param {InternalRegion} right @returns {OverlapContext} */
function buildOverlapContext(left, right) {
  const xFraction = axisOverlapRatio(left.contentBbox, right.contentBbox, "x");
  const yFraction = axisOverlapRatio(left.contentBbox, right.contentBbox, "y");
  const axis = /** @type {"x"|"y"} */ (xFraction < yFraction ? "x" : "y");
  const startKey = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const endKey = /** @type {"x2"|"y2"} */ (`${axis}2`);
  const leftCenter =
    (left.contentBbox[startKey] + left.contentBbox[endKey]) / 2;
  const rightCenter =
    (right.contentBbox[startKey] + right.contentBbox[endKey]) / 2;
  const before = leftCenter <= rightCenter ? left : right;
  return {
    axis,
    startKey,
    endKey,
    before,
    after: before === left ? right : left,
    xFraction,
    yFraction,
  };
}

/** @param {OverlapContext} context */
function clipNarrowContentSeam(context) {
  const boundary = Math.round(
    (context.before.contentBbox[context.endKey] +
      context.after.contentBbox[context.startKey]) /
      2,
  );
  if (!clipContentSeam(context.before, context.after, context.axis, boundary)) {
    return false;
  }
  addRegionReason(context.before, "narrow_content_seam");
  addRegionReason(context.after, "narrow_content_seam");
  return true;
}

/**
 * @param {OverlapContext} context
 * @param {InternalRegion} left
 * @param {InternalRegion} right
 */
function clipDisplayContent(context, left, right) {
  const leftDisplay = isDisplayOnlyRegion(left);
  const rightDisplay = isDisplayOnlyRegion(right);
  if (leftDisplay === rightDisplay) return false;
  const display = leftDisplay ? left : right;
  const ordinary = leftDisplay ? right : left;
  const displayCenter =
    (display.contentBbox[context.startKey] +
      display.contentBbox[context.endKey]) /
    2;
  const ordinaryCenter =
    (ordinary.contentBbox[context.startKey] +
      ordinary.contentBbox[context.endKey]) /
    2;
  const clipped =
    displayCenter <= ordinaryCenter
      ? clipRegionEnd(
          display,
          context.axis,
          ordinary.cropBbox[context.startKey],
        )
      : clipRegionStart(
          display,
          context.axis,
          ordinary.cropBbox[context.endKey],
        );
  if (clipped) addRegionReason(display, "display_priority_clip");
  return clipped;
}

/**
 * @param {InternalRegion} before
 * @param {InternalRegion} after
 * @param {"x"|"y"} axis
 * @param {number} boundary
 */
function clipContentSeam(before, after, axis, boundary) {
  const endKey = /** @type {"x2"|"y2"} */ (`${axis}2`);
  const startKey = /** @type {"x1"|"y1"} */ (`${axis}1`);
  if (
    boundary <= before.cropBbox[startKey] ||
    boundary >= after.cropBbox[endKey]
  ) {
    return false;
  }
  const beforeEnd = Math.min(before.cropBbox[endKey], boundary);
  const afterStart = Math.max(after.cropBbox[startKey], boundary);
  if (
    beforeEnd === before.cropBbox[endKey] &&
    afterStart === after.cropBbox[startKey]
  ) {
    return false;
  }
  const beforeCrop = { ...before.cropBbox, [endKey]: beforeEnd };
  const afterCrop = { ...after.cropBbox, [startKey]: afterStart };
  if (
    !cropRetainsEveryCandidate(before, beforeCrop) ||
    !cropRetainsEveryCandidate(after, afterCrop)
  ) {
    return false;
  }
  before.cropBbox[endKey] = beforeEnd;
  after.cropBbox[startKey] = afterStart;
  return true;
}

/** @param {InternalRegion} region @param {"x"|"y"} axis @param {number} boundary */
function clipRegionEnd(region, axis, boundary) {
  const startKey = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const endKey = /** @type {"x2"|"y2"} */ (`${axis}2`);
  if (
    boundary <= region.cropBbox[startKey] ||
    region.cropBbox[endKey] <= boundary
  ) {
    return false;
  }
  const nextCrop = { ...region.cropBbox, [endKey]: boundary };
  if (!cropRetainsEveryCandidate(region, nextCrop)) return false;
  region.cropBbox[endKey] = boundary;
  return true;
}

/** @param {InternalRegion} region @param {"x"|"y"} axis @param {number} boundary */
function clipRegionStart(region, axis, boundary) {
  const startKey = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const endKey = /** @type {"x2"|"y2"} */ (`${axis}2`);
  if (
    boundary >= region.cropBbox[endKey] ||
    region.cropBbox[startKey] >= boundary
  ) {
    return false;
  }
  const nextCrop = { ...region.cropBbox, [startKey]: boundary };
  if (!cropRetainsEveryCandidate(region, nextCrop)) return false;
  region.cropBbox[startKey] = boundary;
  return true;
}

/** @param {InternalRegion} region @param {PageBox} cropBbox */
function cropRetainsEveryCandidate(region, cropBbox) {
  return region.fragments.every((fragment) =>
    fragment.candidates.every(
      (candidate) => boxIntersectionArea(candidate.bbox, cropBbox) > 0,
    ),
  );
}

/** @param {InternalRegion} region */
function isDisplayOnlyRegion(region) {
  return (
    region.fragments.length > 0 &&
    region.fragments.every(
      (fragment) =>
        fragment.status === "deferred" &&
        fragment.reasons.some((reason) =>
          FORBIDDEN_DEFERRED_HOST_REASONS.has(reason),
        ),
    )
  );
}

/** @param {InternalRegion} region @param {string} reason */
function addRegionReason(region, reason) {
  if (!region.reasons.includes(reason)) {
    region.reasons.push(reason);
    region.reasons.sort();
  }
}

/** @param {InternalRegion[]} regions */
function clipPaddingOverlaps(regions) {
  for (
    let iteration = 0;
    iteration < Math.max(1, regions.length);
    iteration += 1
  ) {
    let changed = false;
    for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < regions.length;
        rightIndex += 1
      ) {
        changed =
          clipRegionPair(regions[leftIndex], regions[rightIndex]) || changed;
      }
    }
    if (!changed) break;
  }
}

/** @param {InternalRegion} left @param {InternalRegion} right */
function clipRegionPair(left, right) {
  if (boxIntersectionArea(left.cropBbox, right.cropBbox) <= 0) return false;
  const separator = chooseContentSeparator(left, right);
  if (!separator) return false;
  const before = separator.leftBeforeRight ? left : right;
  const after = separator.leftBeforeRight ? right : left;
  const endKey = /** @type {"x2"|"y2"} */ (`${separator.axis}2`);
  const startKey = /** @type {"x1"|"y1"} */ (`${separator.axis}1`);
  const clippedBefore = before.cropBbox[endKey] > separator.boundary;
  const clippedAfter = after.cropBbox[startKey] < separator.boundary;
  if (clippedBefore) before.cropBbox[endKey] = separator.boundary;
  if (clippedAfter) after.cropBbox[startKey] = separator.boundary;
  return clippedBefore || clippedAfter;
}

/** @param {InternalRegion} left @param {InternalRegion} right */
function chooseContentSeparator(left, right) {
  /** @type {{axis:"x"|"y";leftBeforeRight:boolean;boundary:number;removed:number}[]} */
  const choices = [];
  collectAxisSeparatorChoice(choices, left, right, "x");
  collectAxisSeparatorChoice(choices, left, right, "y");
  choices.sort(
    (first, second) =>
      first.removed - second.removed ||
      first.axis.localeCompare(second.axis) ||
      first.boundary - second.boundary,
  );
  return choices[0] || null;
}

/**
 * @param {{axis:"x"|"y";leftBeforeRight:boolean;boundary:number;removed:number}[]} choices
 * @param {InternalRegion} left
 * @param {InternalRegion} right
 * @param {"x"|"y"} axis
 */
function collectAxisSeparatorChoice(choices, left, right, axis) {
  const startKey = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const endKey = /** @type {"x2"|"y2"} */ (`${axis}2`);
  if (left.contentBbox[endKey] <= right.contentBbox[startKey]) {
    choices.push(
      buildSeparatorChoice(left, right, axis, startKey, endKey, true),
    );
  } else if (right.contentBbox[endKey] <= left.contentBbox[startKey]) {
    choices.push(
      buildSeparatorChoice(right, left, axis, startKey, endKey, false),
    );
  }
}

/**
 * @param {InternalRegion} before @param {InternalRegion} after
 * @param {"x"|"y"} axis @param {"x1"|"y1"} startKey
 * @param {"x2"|"y2"} endKey @param {boolean} leftBeforeRight
 */
function buildSeparatorChoice(
  before,
  after,
  axis,
  startKey,
  endKey,
  leftBeforeRight,
) {
  const boundary = Math.round(
    (before.contentBbox[endKey] + after.contentBbox[startKey]) / 2,
  );
  return {
    axis,
    leftBeforeRight,
    boundary,
    removed:
      Math.max(0, before.cropBbox[endKey] - boundary) +
      Math.max(0, boundary - after.cropBbox[startKey]),
  };
}

/** @param {InternalRegion[]} regions @returns {[number,number][]} */
function collectCropConflicts(regions) {
  /** @type {[number,number][]} */
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < regions.length;
      rightIndex += 1
    ) {
      if (
        boxIntersectionArea(
          regions[leftIndex].cropBbox,
          regions[rightIndex].cropBbox,
        ) > 0
      ) {
        conflicts.push([leftIndex, rightIndex]);
      }
    }
  }
  return conflicts;
}

/**
 * @param {InternalRegion[]} regions
 * @param {[number,number][]} conflicts
 * @returns {InternalRegion[]}
 */
function mergeConflictComponents(regions, conflicts) {
  const disjoint = createNumericDisjointSet(regions.length);
  for (const [left, right] of conflicts) disjoint.union(left, right);
  /** @type {Map<number,InternalRegion[]>} */
  const components = new Map();
  for (let index = 0; index < regions.length; index += 1) {
    const root = disjoint.find(index);
    const members = components.get(root) || [];
    members.push(regions[index]);
    components.set(root, members);
  }
  return [...components.values()].map(mergeRegionComponent);
}

/** @param {InternalRegion[]} members @returns {InternalRegion} */
function mergeRegionComponent(members) {
  if (members.length === 1) return members[0];
  return {
    reasons: [
      ...new Set([
        ...members.flatMap((region) => region.reasons),
        "joint_content_overlap",
      ]),
    ].sort(),
    fragments: [
      ...new Map(
        members
          .flatMap((region) => region.fragments)
          .map((fragment) => [fragment.fragmentId, fragment]),
      ).values(),
    ].sort((left, right) => left.fragmentId.localeCompare(right.fragmentId)),
    contentBbox: unionBoxes(
      members.flatMap((region) =>
        region.fragments.flatMap((fragment) =>
          fragment.candidates.map((candidate) => candidate.bbox),
        ),
      ),
    ),
    cropBbox: unionBoxes(members.map((region) => region.cropBbox)),
    padding: {
      x: Math.max(...members.map((region) => region.padding.x)),
      y: Math.max(...members.map((region) => region.padding.y)),
    },
  };
}

module.exports = { createPaddedRegion, resolveCropOverlaps };
