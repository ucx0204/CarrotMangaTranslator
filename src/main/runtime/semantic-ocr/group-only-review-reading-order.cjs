// @ts-check

const { axisOverlapRatio } = require("./group-only-review-values.cjs");

/** @typedef {import("./group-only-review-types").Box} Box */
/** @typedef {import("./group-only-review-types").ReviewCandidate} ReviewCandidate */

/**
 * Group-review candidates arrive in crop/fragment serialization order. Once
 * the model joins fragments, that order is no longer a valid reading-order
 * contract, so derive one from the immutable Paddle boxes.
 *
 * Japanese vertical groups read columns right-to-left and each column
 * top-to-bottom. Horizontal groups read rows top-to-bottom and each row
 * left-to-right.
 *
 * @param {ReviewCandidate[]} candidates
 * @returns {ReviewCandidate[]}
 */
function orderReviewCandidatesByGeometry(candidates) {
  if (candidates.length < 2) return [...candidates];
  return isVerticalReadingGroup(candidates)
    ? orderVerticalCandidates(candidates)
    : orderHorizontalCandidates(candidates);
}

/** @param {ReviewCandidate[]} candidates */
function isVerticalReadingGroup(candidates) {
  let verticalCount = 0;
  let horizontalCount = 0;
  for (const candidate of candidates) {
    const { width, height } = boxSize(candidate.bbox);
    if (height >= width * 1.2) verticalCount += 1;
    else if (width >= height * 1.2) horizontalCount += 1;
  }
  return (
    verticalCount > 0 &&
    verticalCount * 2 >= candidates.length &&
    verticalCount > horizontalCount
  );
}

/** @param {ReviewCandidate[]} candidates */
function orderVerticalCandidates(candidates) {
  const canonical = [...candidates].sort(compareCanonical);
  const vertical = canonical.filter((candidate) =>
    isVerticalBox(candidate.bbox),
  );
  const columns = collectConnectedSets(vertical, sameVerticalColumn);

  for (const candidate of canonical) {
    if (isVerticalBox(candidate.bbox)) continue;
    const compatible = columns.filter((column) =>
      compatibleWithVerticalColumn(candidate, column),
    );
    if (compatible.length === 0) {
      columns.push([candidate]);
      continue;
    }
    compatible.sort(
      (left, right) =>
        Math.abs(centerX(candidate.bbox) - verticalColumnCenter(left)) -
          Math.abs(centerX(candidate.bbox) - verticalColumnCenter(right)) ||
        verticalColumnCenter(right) - verticalColumnCenter(left) ||
        compareCandidateLists(left, right),
    );
    compatible[0].push(candidate);
  }

  columns.sort(
    (left, right) =>
      verticalColumnCenter(right) - verticalColumnCenter(left) ||
      compareCandidateLists(left, right),
  );
  return columns.flatMap((column) =>
    column.sort(
      (left, right) =>
        left.bbox.y1 - right.bbox.y1 ||
        centerY(left.bbox) - centerY(right.bbox) ||
        left.bbox.x1 - right.bbox.x1 ||
        left.bbox.x2 - right.bbox.x2 ||
        left.bbox.y2 - right.bbox.y2 ||
        left.id - right.id,
    ),
  );
}

/** @param {ReviewCandidate[]} candidates */
function orderHorizontalCandidates(candidates) {
  const canonical = [...candidates].sort(compareCanonical);
  const horizontal = canonical.filter((candidate) =>
    isHorizontalBox(candidate.bbox),
  );
  const rows = collectConnectedSets(horizontal, sameHorizontalRow);

  for (const candidate of canonical) {
    if (isHorizontalBox(candidate.bbox)) continue;
    const compatible = rows.filter((row) =>
      compatibleWithHorizontalRow(candidate, row),
    );
    if (compatible.length === 0) {
      rows.push([candidate]);
      continue;
    }
    compatible.sort(
      (left, right) =>
        Math.abs(centerY(candidate.bbox) - horizontalRowCenter(left)) -
          Math.abs(centerY(candidate.bbox) - horizontalRowCenter(right)) ||
        horizontalRowCenter(left) - horizontalRowCenter(right) ||
        compareCandidateLists(left, right),
    );
    compatible[0].push(candidate);
  }

  rows.sort(
    (left, right) =>
      horizontalRowCenter(left) - horizontalRowCenter(right) ||
      compareCandidateLists(left, right),
  );
  return rows.flatMap((row) =>
    row.sort(
      (left, right) =>
        left.bbox.x1 - right.bbox.x1 ||
        centerX(left.bbox) - centerX(right.bbox) ||
        left.bbox.y1 - right.bbox.y1 ||
        left.bbox.y2 - right.bbox.y2 ||
        left.bbox.x2 - right.bbox.x2 ||
        left.id - right.id,
    ),
  );
}

/**
 * @param {ReviewCandidate[]} candidates
 * @param {(left:ReviewCandidate,right:ReviewCandidate)=>boolean} connected
 */
function collectConnectedSets(candidates, connected) {
  const parent = candidates.map((_, index) => index);
  /** @param {number} index */
  const root = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (!connected(candidates[left], candidates[right])) continue;
      const leftRoot = root(left);
      const rightRoot = root(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    }
  }
  /** @type {Map<number,ReviewCandidate[]>} */
  const groups = new Map();
  candidates.forEach((candidate, index) => {
    const key = root(index);
    const members = groups.get(key) ?? [];
    members.push(candidate);
    groups.set(key, members);
  });
  return [...groups.values()];
}

/** @param {ReviewCandidate} left @param {ReviewCandidate} right */
function sameVerticalColumn(left, right) {
  const leftSize = boxSize(left.bbox);
  const rightSize = boxSize(right.bbox);
  const centerDelta = Math.abs(centerX(left.bbox) - centerX(right.bbox));
  const centerTolerance = Math.max(
    4,
    Math.min(leftSize.width, rightSize.width) * 0.12,
  );
  if (
    centerDelta <= centerTolerance &&
    axisOverlapRatio(left.bbox, right.bbox, "x") >= 0.45
  ) {
    return true;
  }
  const yGap = axisGap(left.bbox, right.bbox, "y");
  const yOverlap = axisOverlapRatio(left.bbox, right.bbox, "y");
  const widthRatio =
    Math.min(leftSize.width, rightSize.width) /
    Math.max(leftSize.width, rightSize.width);
  return (
    leftSize.height >= leftSize.width * 1.5 &&
    rightSize.height >= rightSize.width * 1.5 &&
    yOverlap < 0.72 &&
    axisOverlapRatio(left.bbox, right.bbox, "x") >= 0.62 &&
    yGap <= Math.max(14, Math.min(leftSize.width, rightSize.width) * 0.9) &&
    widthRatio >= 0.5 &&
    centerDelta <= Math.max(4, Math.min(leftSize.width, rightSize.width) * 0.35)
  );
}

/** @param {ReviewCandidate} left @param {ReviewCandidate} right */
function sameHorizontalRow(left, right) {
  const leftSize = boxSize(left.bbox);
  const rightSize = boxSize(right.bbox);
  const centerDelta = Math.abs(centerY(left.bbox) - centerY(right.bbox));
  const centerTolerance = Math.max(
    4,
    Math.min(leftSize.height, rightSize.height) * 0.12,
  );
  if (
    centerDelta <= centerTolerance &&
    axisOverlapRatio(left.bbox, right.bbox, "y") >= 0.45
  ) {
    return true;
  }
  const xGap = axisGap(left.bbox, right.bbox, "x");
  const xOverlap = axisOverlapRatio(left.bbox, right.bbox, "x");
  const heightRatio =
    Math.min(leftSize.height, rightSize.height) /
    Math.max(leftSize.height, rightSize.height);
  return (
    leftSize.width >= leftSize.height * 1.5 &&
    rightSize.width >= rightSize.height * 1.5 &&
    xOverlap < 0.72 &&
    axisOverlapRatio(left.bbox, right.bbox, "y") >= 0.62 &&
    xGap <= Math.max(14, Math.min(leftSize.height, rightSize.height) * 0.9) &&
    heightRatio >= 0.5 &&
    centerDelta <=
      Math.max(4, Math.min(leftSize.height, rightSize.height) * 0.35)
  );
}

/** @param {ReviewCandidate} candidate @param {ReviewCandidate[]} column */
function compatibleWithVerticalColumn(candidate, column) {
  const candidateWidth = boxSize(candidate.bbox).width;
  const columnWidth = median(
    column.map((item) => boxSize(item.bbox).width).sort((a, b) => a - b),
  );
  const centerDelta = Math.abs(
    centerX(candidate.bbox) - verticalColumnCenter(column),
  );
  const overlap = Math.max(
    ...column.map((item) => axisOverlapRatio(candidate.bbox, item.bbox, "x")),
  );
  return (
    centerDelta <= Math.max(6, Math.min(candidateWidth, columnWidth) * 0.55) &&
    overlap >= 0.2
  );
}

/** @param {ReviewCandidate} candidate @param {ReviewCandidate[]} row */
function compatibleWithHorizontalRow(candidate, row) {
  const candidateHeight = boxSize(candidate.bbox).height;
  const rowHeight = median(
    row.map((item) => boxSize(item.bbox).height).sort((a, b) => a - b),
  );
  const centerDelta = Math.abs(
    centerY(candidate.bbox) - horizontalRowCenter(row),
  );
  const overlap = Math.max(
    ...row.map((item) => axisOverlapRatio(candidate.bbox, item.bbox, "y")),
  );
  return (
    centerDelta <= Math.max(6, Math.min(candidateHeight, rowHeight) * 0.55) &&
    overlap >= 0.2
  );
}

/** @param {ReviewCandidate[]} column */
function verticalColumnCenter(column) {
  const verticalCenters = column
    .filter((candidate) => isVerticalBox(candidate.bbox))
    .map((candidate) => centerX(candidate.bbox))
    .sort((a, b) => a - b);
  const centers =
    verticalCenters.length > 0
      ? verticalCenters
      : column
          .map((candidate) => centerX(candidate.bbox))
          .sort((a, b) => a - b);
  return median(centers);
}

/** @param {ReviewCandidate[]} row */
function horizontalRowCenter(row) {
  const horizontalCenters = row
    .filter((candidate) => isHorizontalBox(candidate.bbox))
    .map((candidate) => centerY(candidate.bbox))
    .sort((a, b) => a - b);
  const centers =
    horizontalCenters.length > 0
      ? horizontalCenters
      : row.map((candidate) => centerY(candidate.bbox)).sort((a, b) => a - b);
  return median(centers);
}

/** @param {ReviewCandidate[]} left @param {ReviewCandidate[]} right */
function compareCandidateLists(left, right) {
  return compareCanonical(
    [...left].sort(compareCanonical)[0],
    [...right].sort(compareCanonical)[0],
  );
}

/** @param {ReviewCandidate} left @param {ReviewCandidate} right */
function compareCanonical(left, right) {
  return (
    left.bbox.y1 - right.bbox.y1 ||
    left.bbox.x1 - right.bbox.x1 ||
    left.bbox.y2 - right.bbox.y2 ||
    left.bbox.x2 - right.bbox.x2 ||
    left.id - right.id
  );
}

/** @param {Box} box */
function isVerticalBox(box) {
  const { width, height } = boxSize(box);
  return height >= width * 1.2;
}

/** @param {Box} box */
function isHorizontalBox(box) {
  const { width, height } = boxSize(box);
  return width >= height * 1.2;
}

/** @param {Box} box */
function boxSize(box) {
  return {
    width: Math.max(1, box.x2 - box.x1),
    height: Math.max(1, box.y2 - box.y1),
  };
}

/** @param {Box} box */
function centerX(box) {
  return (box.x1 + box.x2) / 2;
}

/** @param {Box} box */
function centerY(box) {
  return (box.y1 + box.y2) / 2;
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

/** @param {number[]} sorted */
function median(sorted) {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

module.exports = { orderReviewCandidatesByGeometry };
