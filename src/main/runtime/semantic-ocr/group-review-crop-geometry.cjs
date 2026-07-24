// @ts-check

/** @typedef {import("./group-review-crop-types").PageBox} PageBox */
/** @typedef {import("./group-review-crop-types").CropRect} CropRect */
/** @typedef {import("./group-review-crop-types").ReviewCandidate} ReviewCandidate */
/** @typedef {import("./group-review-crop-types").ReviewFragment} ReviewFragment */
/** @typedef {import("./group-review-crop-types").InternalRegion} InternalRegion */

/**
 * @param {PageBox} pageBbox
 * @param {PageBox} cropBbox
 * @returns {[number,number,number,number]}
 */
function projectBoxToCrop1000(pageBbox, cropBbox) {
  const width = Math.max(1, cropBbox.x2 - cropBbox.x1);
  const height = Math.max(1, cropBbox.y2 - cropBbox.y1);
  return [
    clamp(Math.floor(((pageBbox.x1 - cropBbox.x1) / width) * 1000), 0, 1000),
    clamp(Math.floor(((pageBbox.y1 - cropBbox.y1) / height) * 1000), 0, 1000),
    clamp(Math.ceil(((pageBbox.x2 - cropBbox.x1) / width) * 1000), 0, 1000),
    clamp(Math.ceil(((pageBbox.y2 - cropBbox.y1) / height) * 1000), 0, 1000),
  ];
}

/**
 * @param {PageBox} confirmed
 * @param {PageBox} deferred
 * @param {number} contactMargin
 * @returns {number|null}
 */
function deferredHostScore(confirmed, deferred, contactMargin) {
  const intersection = boxIntersectionArea(confirmed, deferred);
  const smallerCoverage =
    intersection / Math.max(1, Math.min(boxArea(confirmed), boxArea(deferred)));
  const deferredCoverage = intersection / Math.max(1, boxArea(deferred));
  const confirmedOrientation = boxOrientation(confirmed);
  const deferredOrientation = boxOrientation(deferred);
  const orientationCompatible =
    confirmedOrientation === deferredOrientation ||
    confirmedOrientation === "ambiguous" ||
    deferredOrientation === "ambiguous";
  const alignedContact =
    alignedContextAxis(confirmed, deferred, contactMargin) !== null;
  let evidencePenalty;
  if (
    intersection > 0 &&
    (smallerCoverage >= 0.08 || deferredCoverage >= 0.22)
  ) {
    evidencePenalty = 0;
  } else if (orientationCompatible && alignedContact) {
    evidencePenalty = 0.35;
  } else {
    return null;
  }
  const gapX = axisGap(confirmed, deferred, "x");
  const gapY = axisGap(confirmed, deferred, "y");
  const localScale = Math.max(
    1,
    Math.min(
      confirmed.x2 - confirmed.x1,
      confirmed.y2 - confirmed.y1,
      deferred.x2 - deferred.x1,
      deferred.y2 - deferred.y1,
    ),
  );
  return (
    evidencePenalty +
    (gapX + gapY) / localScale +
    (1 - Math.min(1, deferredCoverage)) * 0.25
  );
}

/**
 * Return the separating axis only when boxes share enough perpendicular span.
 * A corner/diagonal gap therefore never becomes grouping evidence.
 *
 * @param {PageBox} left
 * @param {PageBox} right
 * @param {number} margin
 * @returns {"x"|"y"|null}
 */
function alignedContextAxis(left, right, margin) {
  const options = [];
  const gapX = axisGap(left, right, "x");
  const gapY = axisGap(left, right, "y");
  const xOverlap = axisOverlapRatio(left, right, "x");
  const yOverlap = axisOverlapRatio(left, right, "y");
  if (xOverlap >= 0.45 && gapY <= margin) {
    options.push({ axis: /** @type {"y"} */ ("y"), score: gapY });
  }
  if (yOverlap >= 0.45 && gapX <= margin) {
    options.push({ axis: /** @type {"x"} */ ("x"), score: gapX });
  }
  if (options.length === 0) return null;
  const leftOrientation = boxOrientation(left);
  const rightOrientation = boxOrientation(right);
  const sharedOrientation =
    leftOrientation === rightOrientation ? leftOrientation : "ambiguous";
  const preferredAxis =
    sharedOrientation === "vertical"
      ? "x"
      : sharedOrientation === "horizontal"
        ? "y"
        : null;
  return (
    options.find((option) => option.axis === preferredAxis)?.axis ||
    options.sort(
      (first, second) =>
        first.score - second.score || first.axis.localeCompare(second.axis),
    )[0].axis
  );
}

/**
 * @param {ReviewCandidate} candidate
 * @param {number} id
 * @returns {PageBox}
 */
function normalizeCandidateBox(candidate, id) {
  const raw = candidate.bbox;
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? [
          /** @type {Record<string,unknown>} */ (raw).x1,
          /** @type {Record<string,unknown>} */ (raw).y1,
          /** @type {Record<string,unknown>} */ (raw).x2,
          /** @type {Record<string,unknown>} */ (raw).y2,
        ]
      : [candidate.x1, candidate.y1, candidate.x2, candidate.y2];
  if (values.length !== 4) {
    throw new Error(`candidate ${id}.bbox must contain four coordinates.`);
  }
  const [x1, y1, x2, y2] = values.map((value, coordinateIndex) =>
    requireInteger(value, `candidate ${id}.bbox[${coordinateIndex}]`),
  );
  if (!(x1 < x2 && y1 < y2)) {
    throw new Error(`candidate ${id}.bbox has invalid coordinate order.`);
  }
  return { x1, y1, x2, y2 };
}

/**
 * @param {unknown} value
 * @param {number} candidateId
 * @returns {string[]}
 */
function normalizeReasons(value, candidateId) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`candidate ${candidateId}.reviewReasons must be an array.`);
  }
  return [
    ...new Set(
      value.map((reason, index) => {
        const normalized = String(reason ?? "").trim();
        if (!normalized) {
          throw new Error(
            `candidate ${candidateId}.reviewReasons[${index}] is empty.`,
          );
        }
        return normalized;
      }),
    ),
  ].sort();
}

/**
 * @param {ReviewFragment[]} values
 * @param {{find(value:string):string}} disjoint
 * @returns {ReviewFragment[][]}
 */
function collectDisjointComponents(values, disjoint) {
  /** @type {Map<string,ReviewFragment[]>} */
  const components = new Map();
  for (const value of values) {
    const root = disjoint.find(value.fragmentId);
    const members = components.get(root) || [];
    members.push(value);
    components.set(root, members);
  }
  return [...components.values()].map((members) =>
    members.sort((left, right) =>
      left.fragmentId.localeCompare(right.fragmentId),
    ),
  );
}

/** @param {string[]} values */
function createDisjointSet(values) {
  const parent = new Map(values.map((value) => [value, value]));
  return {
    /** @param {string} value */
    find(value) {
      let root = value;
      while (parent.get(root) !== root) root = String(parent.get(root));
      let current = value;
      while (parent.get(current) !== root) {
        const next = String(parent.get(current));
        parent.set(current, root);
        current = next;
      }
      return root;
    },
    /** @param {string} left @param {string} right */
    union(left, right) {
      const leftRoot = this.find(left);
      const rightRoot = this.find(right);
      if (leftRoot === rightRoot) return leftRoot;
      const keep =
        leftRoot.localeCompare(rightRoot) <= 0 ? leftRoot : rightRoot;
      const drop = keep === leftRoot ? rightRoot : leftRoot;
      parent.set(drop, keep);
      return keep;
    },
  };
}

/** @param {number} size */
function createNumericDisjointSet(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  return {
    /** @param {number} value */
    find(value) {
      let current = value;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    },
    /** @param {number} left @param {number} right */
    union(left, right) {
      const leftRoot = this.find(left);
      const rightRoot = this.find(right);
      if (leftRoot === rightRoot) return leftRoot;
      const keep = Math.min(leftRoot, rightRoot);
      parent[Math.max(leftRoot, rightRoot)] = keep;
      return keep;
    },
  };
}

/** @param {PageBox[]} boxes @returns {PageBox} */
function unionBoxes(boxes) {
  if (boxes.length === 0) throw new Error("Cannot union zero review boxes.");
  return {
    x1: Math.min(...boxes.map((box) => box.x1)),
    y1: Math.min(...boxes.map((box) => box.y1)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2)),
  };
}

/** @param {PageBox} left @param {PageBox} right */
function boxIntersectionArea(left, right) {
  return (
    Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1)) *
    Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1))
  );
}

/** @param {PageBox} box */
function boxArea(box) {
  return Math.max(1, box.x2 - box.x1) * Math.max(1, box.y2 - box.y1);
}

/** @param {PageBox} outer @param {PageBox} inner */
function boxContains(outer, inner) {
  return (
    outer.x1 <= inner.x1 &&
    outer.y1 <= inner.y1 &&
    outer.x2 >= inner.x2 &&
    outer.y2 >= inner.y2
  );
}

/** @param {PageBox} box @returns {"vertical"|"horizontal"|"ambiguous"} */
function boxOrientation(box) {
  const width = Math.max(1, box.x2 - box.x1);
  const height = Math.max(1, box.y2 - box.y1);
  if (height >= width * 1.2) return "vertical";
  if (width >= height * 1.2) return "horizontal";
  return "ambiguous";
}

/** @param {PageBox} left @param {PageBox} right @param {"x"|"y"} axis */
function axisGap(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return Math.max(
    0,
    Math.max(left[start], right[start]) - Math.min(left[end], right[end]),
  );
}

/** @param {PageBox} left @param {PageBox} right @param {"x"|"y"} axis */
function axisOverlapRatio(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  const overlap = Math.max(
    0,
    Math.min(left[end], right[end]) - Math.max(left[start], right[start]),
  );
  const shortest = Math.max(
    1,
    Math.min(left[end] - left[start], right[end] - right[start]),
  );
  return overlap / shortest;
}

/** @param {InternalRegion} left @param {InternalRegion} right */
function compareRegions(left, right) {
  return (
    left.cropBbox.y1 - right.cropBbox.y1 ||
    left.cropBbox.x1 - right.cropBbox.x1 ||
    firstFragmentId(left).localeCompare(firstFragmentId(right))
  );
}

/** @param {InternalRegion} region */
function firstFragmentId(region) {
  return region.fragments[0]?.fragmentId || "";
}

/** @param {PageBox} box @returns {CropRect} */
function pageBoxToCropRect(box) {
  return {
    x: box.x1,
    y: box.y1,
    width: box.x2 - box.x1,
    height: box.y2 - box.y1,
  };
}

/**
 * @param {PageBox} box
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {string} label
 */
function assertBoxInsidePage(box, pageWidth, pageHeight, label) {
  if (
    !Number.isInteger(box.x1) ||
    !Number.isInteger(box.y1) ||
    !Number.isInteger(box.x2) ||
    !Number.isInteger(box.y2) ||
    box.x1 < 0 ||
    box.y1 < 0 ||
    box.x2 > pageWidth ||
    box.y2 > pageHeight ||
    box.x1 >= box.x2 ||
    box.y1 >= box.y2
  ) {
    throw new Error(`${label} is outside the source page.`);
  }
}

/** @param {[number,number,number,number]} bbox @param {string} label */
function assertBbox1000(bbox, label) {
  if (
    bbox.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 1000,
    ) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3]
  ) {
    throw new Error(`${label} bbox1000 is invalid.`);
  }
}

/** @param {PageBox} left @param {PageBox} right */
function sameBox(left, right) {
  return (
    left.x1 === right.x1 &&
    left.y1 === right.y1 &&
    left.x2 === right.x2 &&
    left.y2 === right.y2
  );
}

/** @param {unknown[]} left @param {unknown[]} right */
function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** @param {unknown} value @param {string} label */
function requireInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric))
    throw new Error(`${label} must be an integer.`);
  return numeric;
}

/** @param {unknown} value @param {string} label */
function requirePositiveInteger(value, label) {
  const numeric = requireInteger(value, label);
  if (numeric <= 0) throw new Error(`${label} must be positive.`);
  return numeric;
}

/** @param {unknown} value @returns {string|null} */
function normalizeOptionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number|null}
 */
function normalizeOptionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return requirePositiveInteger(value, label);
}

/** @param {number} value @param {number} minimum @param {number} maximum */
function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

module.exports = {
  alignedContextAxis,
  assertBbox1000,
  assertBoxInsidePage,
  axisOverlapRatio,
  boxArea,
  boxContains,
  boxIntersectionArea,
  boxOrientation,
  clamp,
  collectDisjointComponents,
  compareRegions,
  createDisjointSet,
  createNumericDisjointSet,
  deferredHostScore,
  normalizeCandidateBox,
  normalizeOptionalPositiveInteger,
  normalizeOptionalString,
  normalizeReasons,
  pageBoxToCropRect,
  projectBoxToCrop1000,
  requireInteger,
  requirePositiveInteger,
  sameArray,
  sameBox,
  unionBoxes,
};
