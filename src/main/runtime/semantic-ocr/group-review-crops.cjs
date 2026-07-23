// @ts-check
/* eslint-disable max-lines, complexity, max-depth -- the accepted crop partitioner and its invariants stay frozen together */

const {
  resolveElectronNativeImage,
} = require("../assets/image-source-assets.cjs");

const GROUP_REVIEW_CROP_PLAN_VERSION = 1;
const FORBIDDEN_DEFERRED_HOST_REASONS = new Set([
  "oversized_display_text",
  "oversized_uncertain_sfx",
]);

/**
 * @typedef {"confirmed"|"deferred"} ReviewStatus
 * @typedef {{x1:number;y1:number;x2:number;y2:number}} PageBox
 * @typedef {{x:number;y:number;width:number;height:number}} CropRect
 * @typedef {{id:number;bbox?:unknown;x1?:unknown;y1?:unknown;x2?:unknown;y2?:unknown;reviewFragmentId?:unknown;reviewStatus?:unknown;reviewReasons?:unknown;reviewOrder?:unknown;paddleGroupId?:unknown;paddleOrder?:unknown;paddleGroupSize?:unknown;[key:string]:unknown}} ReviewCandidate
 * @typedef {{id:number;fragmentId:string;status:ReviewStatus;reasons:string[];order:number;bbox:PageBox;paddleGroupId:string|null;paddleOrder:number|null;paddleGroupSize:number|null}} NormalizedCandidate
 * @typedef {{fragmentId:string;status:ReviewStatus;reasons:string[];candidates:NormalizedCandidate[];bbox:PageBox}} ReviewFragment
 * @typedef {{reasons:string[];fragments:ReviewFragment[];contentBbox:PageBox;cropBbox:PageBox;padding:{x:number;y:number}}} InternalRegion
 * @typedef {{candidateId:number;reviewFragmentId:string;reviewStatus:ReviewStatus;reviewOrder:number;paddleGroupId:string|null;paddleOrder:number|null;paddleGroupSize:number|null;bbox:PageBox;bbox1000:[number,number,number,number]}} CropCandidate
 * @typedef {{reviewFragmentId:string;reviewStatus:ReviewStatus;reviewReasons:string[];candidateIds:number[];bbox:PageBox;bbox1000:[number,number,number,number]}} CropFragment
 * @typedef {{cropId:string;reasons:string[];confirmedFragmentIds:string[];deferredFragmentIds:string[];fragmentIds:string[];candidateIds:number[];fragments:CropFragment[];candidates:CropCandidate[];contentBbox:PageBox;cropBbox:PageBox;cropRect:CropRect;padding:{x:number;y:number}}} GroupReviewCropRegion
 * @typedef {{version:number;pageWidth:number;pageHeight:number;fragmentCount:number;candidateCount:number;regions:GroupReviewCropRegion[]}} GroupReviewCropPlan
 * @typedef {{role:string;path:string;dataUrl:string;mime:string;width:number;height:number;originalWidth:number;originalHeight:number;semanticReviewCropId:string;semanticCropRect:CropRect}} GroupReviewImageVariant
 * @typedef {{region:GroupReviewCropRegion;variant:GroupReviewImageVariant}} PreparedGroupReviewCrop
 * @typedef {{crops:PreparedGroupReviewCrop[];fallbackReason:string|null}} GroupReviewImageResult
 * @typedef {{imagePath?:unknown;imageWidth?:unknown;imageHeight?:unknown;[key:string]:unknown}} GroupReviewCropOptions
 * @typedef {{isEmpty():boolean;crop(rect:CropRect):NativeImageLike;toPNG():Buffer;getSize?():{width:number;height:number}}} NativeImageLike
 * @typedef {{createFromPath(path:string):NativeImageLike}} NativeImageModule
 */

/**
 * Build a deterministic, non-overlapping crop partition from the heuristic
 * fragment metadata. `reviewFragmentId` is authoritative: geometry may place
 * whole fragments in one visual request, but it never splits or silently
 * changes a fragment.
 *
 * @param {ReviewCandidate[]} candidates
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {GroupReviewCropPlan}
 */
function buildGroupReviewCropPlan(candidates, pageWidth, pageHeight) {
  const width = requirePositiveInteger(pageWidth, "pageWidth");
  const height = requirePositiveInteger(pageHeight, "pageHeight");
  const normalized = normalizeCandidates(candidates, width, height);
  const fragments = buildFragments(normalized);
  const confirmed = fragments.filter(
    (fragment) => fragment.status === "confirmed",
  );
  const deferred = fragments.filter(
    (fragment) => fragment.status === "deferred",
  );
  const contactMargin = Math.max(
    4,
    Math.round(Math.min(width, height) * 0.006),
  );
  const deferredOwner = attachDeferredToConfirmed(
    confirmed,
    deferred,
    contactMargin,
  );
  const confirmedComponents = collectOverlappingConfirmed(confirmed);
  /** @type {InternalRegion[]} */
  let regions = confirmedComponents.map((members) => {
    const confirmedIds = new Set(
      members.map((fragment) => fragment.fragmentId),
    );
    const ownedDeferred = deferred.filter((fragment) =>
      confirmedIds.has(deferredOwner.get(fragment.fragmentId) || ""),
    );
    const reasons = [];
    if (members.length > 1) reasons.push("confirmed_bbox_collision");
    if (ownedDeferred.length > 0) reasons.push("deferred_attached_once");
    return createPaddedRegion(
      [...members, ...ownedDeferred],
      reasons,
      width,
      height,
    );
  });

  const hostlessDeferred = deferred.filter(
    (fragment) => !deferredOwner.has(fragment.fragmentId),
  );
  const deferredContextMargin = Math.max(
    contactMargin,
    Math.round(Math.min(width, height) * 0.018),
  );
  for (const members of collectAxisAlignedDeferred(
    hostlessDeferred,
    deferredContextMargin,
  )) {
    regions.push(
      createPaddedRegion(
        members,
        [members.length > 1 ? "deferred_axis_context" : "deferred_only"],
        width,
        height,
      ),
    );
  }

  regions = resolveCropOverlaps(regions);
  regions.sort(compareRegions);
  const publicRegions = regions.map((region, index) =>
    serializeRegion(region, index + 1),
  );
  const plan = {
    version: GROUP_REVIEW_CROP_PLAN_VERSION,
    pageWidth: width,
    pageHeight: height,
    fragmentCount: fragments.length,
    candidateCount: normalized.length,
    regions: publicRegions,
  };
  assertGroupReviewCropPlan(plan, fragments);
  return plan;
}

/**
 * Decode the original page once and create clean, unmarked PNG crops. Failure
 * is atomic so the caller can fall back to the unchanged non-review path.
 *
 * @param {GroupReviewCropOptions} options
 * @param {GroupReviewCropPlan} plan
 * @param {{nativeImageModule?:NativeImageModule|null}} [dependencies]
 * @returns {GroupReviewImageResult}
 */
function buildGroupReviewCropImageVariants(options, plan, dependencies = {}) {
  try {
    return buildGroupReviewCropImageVariantsUnsafe(options, plan, dependencies);
  } catch (error) {
    return imageFallback(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * @param {GroupReviewCropOptions} options
 * @param {GroupReviewCropPlan} plan
 * @param {{nativeImageModule?:NativeImageModule|null}} dependencies
 * @returns {GroupReviewImageResult}
 */
function buildGroupReviewCropImageVariantsUnsafe(options, plan, dependencies) {
  assertGroupReviewCropPlan(plan);
  const imagePath = requireImagePath(options.imagePath);
  const nativeImage = requireNativeImageModule(dependencies.nativeImageModule);
  const source = requireSourceImage(
    nativeImage.createFromPath(imagePath),
    plan,
  );
  const crops = plan.regions.map((region) =>
    createPreparedImageCrop(source, imagePath, plan, region),
  );
  return { crops, fallbackReason: null };
}

/** @param {unknown} value */
function requireImagePath(value) {
  const imagePath = String(value ?? "").trim();
  if (!imagePath) throw new Error("missing-image-path");
  return imagePath;
}

/** @param {NativeImageModule|null|undefined} injected */
function requireNativeImageModule(injected) {
  const nativeImage =
    injected ||
    /** @type {NativeImageModule|null} */ (
      /** @type {unknown} */ (resolveElectronNativeImage())
    );
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") {
    throw new Error("native-image-unavailable");
  }
  return nativeImage;
}

/**
 * @param {NativeImageLike} source
 * @param {GroupReviewCropPlan} plan
 */
function requireSourceImage(source, plan) {
  if (!source || source.isEmpty() || typeof source.crop !== "function") {
    throw new Error("source-decode-failed");
  }
  const sourceSize = source.getSize?.();
  if (
    sourceSize &&
    (sourceSize.width !== plan.pageWidth ||
      sourceSize.height !== plan.pageHeight)
  ) {
    throw new Error("source-size-mismatch");
  }
  return source;
}

/**
 * @param {NativeImageLike} source
 * @param {string} imagePath
 * @param {GroupReviewCropPlan} plan
 * @param {GroupReviewCropRegion} region
 * @returns {PreparedGroupReviewCrop}
 */
function createPreparedImageCrop(source, imagePath, plan, region) {
  const cropped = source.crop(region.cropRect);
  if (!cropped || cropped.isEmpty()) {
    throw new Error(`crop-decode-failed:${region.cropId}`);
  }
  const png = cropped.toPNG();
  if (!Buffer.isBuffer(png) || png.length === 0) {
    throw new Error(`crop-png-failed:${region.cropId}`);
  }
  return {
    region,
    variant: {
      role: "semantic-group-review-crop",
      path: imagePath,
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      mime: "image/png",
      width: region.cropRect.width,
      height: region.cropRect.height,
      originalWidth: plan.pageWidth,
      originalHeight: plan.pageHeight,
      semanticReviewCropId: region.cropId,
      semanticCropRect: { ...region.cropRect },
    },
  };
}

/**
 * @param {ReviewCandidate[]} candidates
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {NormalizedCandidate[]}
 */
function normalizeCandidates(candidates, pageWidth, pageHeight) {
  if (!Array.isArray(candidates)) {
    throw new Error("Group review candidates must be an array.");
  }
  const seenIds = new Set();
  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Group review candidate ${index} is invalid.`);
    }
    const id = requireInteger(candidate.id, `candidate[${index}].id`);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate group review candidate id ${id}.`);
    }
    seenIds.add(id);
    const fragmentId = String(candidate.reviewFragmentId ?? "").trim();
    if (!fragmentId) {
      throw new Error(`candidate ${id} is missing reviewFragmentId.`);
    }
    const status = candidate.reviewStatus;
    if (status !== "confirmed" && status !== "deferred") {
      throw new Error(
        `candidate ${id} reviewStatus must be confirmed or deferred.`,
      );
    }
    const reasons = normalizeReasons(candidate.reviewReasons, id);
    const order = requirePositiveInteger(
      candidate.reviewOrder,
      `candidate ${id}.reviewOrder`,
    );
    const bbox = normalizeCandidateBox(candidate, id);
    assertBoxInsidePage(bbox, pageWidth, pageHeight, `candidate ${id}.bbox`);
    const paddleGroupId = normalizeOptionalString(candidate.paddleGroupId);
    const paddleOrder = normalizeOptionalPositiveInteger(
      candidate.paddleOrder,
      `candidate ${id}.paddleOrder`,
    );
    const paddleGroupSize = normalizeOptionalPositiveInteger(
      candidate.paddleGroupSize,
      `candidate ${id}.paddleGroupSize`,
    );
    return {
      id,
      fragmentId,
      status,
      reasons,
      order,
      bbox,
      paddleGroupId,
      paddleOrder,
      paddleGroupSize,
    };
  });
}

/**
 * @param {NormalizedCandidate[]} candidates
 * @returns {ReviewFragment[]}
 */
function buildFragments(candidates) {
  /** @type {Map<string,NormalizedCandidate[]>} */
  const byFragment = new Map();
  for (const candidate of candidates) {
    const members = byFragment.get(candidate.fragmentId) || [];
    members.push(candidate);
    byFragment.set(candidate.fragmentId, members);
  }
  const fragments = [...byFragment.entries()].map(([fragmentId, members]) => {
    const statuses = new Set(members.map((candidate) => candidate.status));
    if (statuses.size !== 1) {
      throw new Error(`Fragment ${fragmentId} has mixed reviewStatus values.`);
    }
    const orders = members.map((candidate) => candidate.order);
    if (new Set(orders).size !== orders.length) {
      throw new Error(
        `Fragment ${fragmentId} has duplicate reviewOrder values.`,
      );
    }
    members.sort(
      (left, right) => left.order - right.order || left.id - right.id,
    );
    return {
      fragmentId,
      status: members[0].status,
      reasons: [
        ...new Set(members.flatMap((candidate) => candidate.reasons)),
      ].sort(),
      candidates: members,
      bbox: unionBoxes(members.map((candidate) => candidate.bbox)),
    };
  });
  fragments.sort((left, right) =>
    left.fragmentId.localeCompare(right.fragmentId),
  );
  return fragments;
}

/** @param {ReviewFragment[]} confirmed @param {ReviewFragment[]} deferred @param {number} contactMargin @returns {Map<string,string>} */
function attachDeferredToConfirmed(confirmed, deferred, contactMargin) {
  const owners = new Map();
  for (const fragment of deferred) {
    if (
      fragment.reasons.some((reason) =>
        FORBIDDEN_DEFERRED_HOST_REASONS.has(reason),
      )
    ) {
      continue;
    }
    const matches = confirmed
      .flatMap((host) => {
        const score = deferredHostScore(
          host.bbox,
          fragment.bbox,
          contactMargin,
        );
        return score === null ? [] : [{ score, fragmentId: host.fragmentId }];
      })
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.fragmentId.localeCompare(right.fragmentId),
      );
    if (matches.length === 0) continue;
    if (matches.length > 1 && matches[1].score <= matches[0].score + 0.2) {
      continue;
    }
    owners.set(fragment.fragmentId, matches[0].fragmentId);
  }
  return owners;
}

/** @param {ReviewFragment[]} fragments @returns {ReviewFragment[][]} */
function collectOverlappingConfirmed(fragments) {
  const disjoint = createDisjointSet(fragments.map((item) => item.fragmentId));
  for (let leftIndex = 0; leftIndex < fragments.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < fragments.length;
      rightIndex += 1
    ) {
      const left = fragments[leftIndex];
      const right = fragments[rightIndex];
      if (boxIntersectionArea(left.bbox, right.bbox) > 0) {
        disjoint.union(left.fragmentId, right.fragmentId);
      }
    }
  }
  return collectDisjointComponents(fragments, disjoint);
}

/** @param {ReviewFragment[]} fragments @param {number} margin @returns {ReviewFragment[][]} */
function collectAxisAlignedDeferred(fragments, margin) {
  const disjoint = createDisjointSet(fragments.map((item) => item.fragmentId));
  for (let leftIndex = 0; leftIndex < fragments.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < fragments.length;
      rightIndex += 1
    ) {
      const left = fragments[leftIndex];
      const right = fragments[rightIndex];
      if (!alignedContextAxis(left.bbox, right.bbox, margin)) continue;
      const leftOrientation = boxOrientation(left.bbox);
      const rightOrientation = boxOrientation(right.bbox);
      if (
        leftOrientation !== rightOrientation &&
        leftOrientation !== "ambiguous" &&
        rightOrientation !== "ambiguous"
      ) {
        continue;
      }
      disjoint.union(left.fragmentId, right.fragmentId);
    }
  }
  return collectDisjointComponents(fragments, disjoint);
}

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
  const contentWidth = Math.max(1, contentBbox.x2 - contentBbox.x1);
  const contentHeight = Math.max(1, contentBbox.y2 - contentBbox.y1);
  const hasConfirmed = fragments.some(
    (fragment) => fragment.status === "confirmed",
  );
  const orientation = boxOrientation(contentBbox);
  let paddingX;
  let paddingY;
  if (hasConfirmed && orientation === "vertical") {
    paddingX = clamp(Math.round(contentWidth * 0.22), 18, 48);
    paddingY = clamp(Math.round(contentHeight * 0.06), 10, 28);
  } else if (hasConfirmed && orientation === "horizontal") {
    paddingX = clamp(Math.round(contentWidth * 0.06), 10, 28);
    paddingY = clamp(Math.round(contentHeight * 0.22), 18, 48);
  } else if (hasConfirmed) {
    paddingX = clamp(Math.round(contentWidth * 0.12), 14, 36);
    paddingY = clamp(Math.round(contentHeight * 0.12), 14, 36);
  } else {
    paddingX = clamp(Math.round(contentWidth * 0.18), 16, 56);
    paddingY = clamp(Math.round(contentHeight * 0.18), 16, 56);
  }
  return {
    reasons: [...new Set(reasons)].sort(),
    fragments: [...fragments].sort((left, right) =>
      left.fragmentId.localeCompare(right.fragmentId),
    ),
    contentBbox,
    cropBbox: {
      x1: Math.max(0, contentBbox.x1 - paddingX),
      y1: Math.max(0, contentBbox.y1 - paddingY),
      x2: Math.min(pageWidth, contentBbox.x2 + paddingX),
      y2: Math.min(pageHeight, contentBbox.y2 + paddingY),
    },
    padding: { x: paddingX, y: paddingY },
  };
}

/**
 * Divide padding at whitespace. A detector-only hairline collision is cut at
 * its narrow seam, and a huge display/SFX strip yields to ordinary speech.
 * Any remaining genuine content collision becomes one joint crop. This is the
 * stable crop policy: it avoids turning two balloons into one oversized
 * model input while every source candidate still remains in the review
 * partition.
 *
 * @param {InternalRegion[]} initialRegions
 * @returns {InternalRegion[]}
 */
function resolveCropOverlaps(initialRegions) {
  let regions = initialRegions;
  for (
    let iteration = 0;
    iteration < Math.max(1, regions.length * 3);
    iteration += 1
  ) {
    clipPaddingOverlaps(regions);
    let changed = false;
    for (let leftIndex = 0; leftIndex < regions.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < regions.length;
        rightIndex += 1
      ) {
        const left = regions[leftIndex];
        const right = regions[rightIndex];
        if (boxIntersectionArea(left.cropBbox, right.cropBbox) <= 0) continue;

        const xFraction = axisOverlapRatio(
          left.contentBbox,
          right.contentBbox,
          "x",
        );
        const yFraction = axisOverlapRatio(
          left.contentBbox,
          right.contentBbox,
          "y",
        );
        const axis = xFraction < yFraction ? "x" : "y";
        const startKey = /** @type {"x1"|"y1"} */ (`${axis}1`);
        const endKey = /** @type {"x2"|"y2"} */ (`${axis}2`);
        const leftCenter =
          (left.contentBbox[startKey] + left.contentBbox[endKey]) / 2;
        const rightCenter =
          (right.contentBbox[startKey] + right.contentBbox[endKey]) / 2;
        const before = leftCenter <= rightCenter ? left : right;
        const after = before === left ? right : left;

        if (Math.min(xFraction, yFraction) <= 0.04) {
          const boundary = Math.round(
            (before.contentBbox[endKey] + after.contentBbox[startKey]) / 2,
          );
          if (clipContentSeam(before, after, axis, boundary)) {
            addRegionReason(before, "narrow_content_seam");
            addRegionReason(after, "narrow_content_seam");
            changed = true;
          }
          continue;
        }

        const leftDisplay = isDisplayOnlyRegion(left);
        const rightDisplay = isDisplayOnlyRegion(right);
        if (leftDisplay === rightDisplay) continue;
        const display = leftDisplay ? left : right;
        const ordinary = leftDisplay ? right : left;
        const displayCenter =
          (display.contentBbox[startKey] + display.contentBbox[endKey]) / 2;
        const ordinaryCenter =
          (ordinary.contentBbox[startKey] + ordinary.contentBbox[endKey]) / 2;
        const clipped =
          displayCenter <= ordinaryCenter
            ? clipRegionEnd(display, axis, ordinary.cropBbox[startKey])
            : clipRegionStart(display, axis, ordinary.cropBbox[endKey]);
        if (clipped) {
          addRegionReason(display, "display_priority_clip");
          changed = true;
        }
      }
    }
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
  const changed =
    before.cropBbox[endKey] > boundary || after.cropBbox[startKey] < boundary;
  before.cropBbox[endKey] = Math.min(before.cropBbox[endKey], boundary);
  after.cropBbox[startKey] = Math.max(after.cropBbox[startKey], boundary);
  return changed;
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
  region.cropBbox[startKey] = boundary;
  return true;
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

/**
 * @param {InternalRegion} left
 * @param {InternalRegion} right
 * @returns {{axis:"x"|"y";leftBeforeRight:boolean;boundary:number;removed:number}|null}
 */
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
    const boundary = Math.round(
      (left.contentBbox[endKey] + right.contentBbox[startKey]) / 2,
    );
    choices.push({
      axis,
      leftBeforeRight: true,
      boundary,
      removed:
        Math.max(0, left.cropBbox[endKey] - boundary) +
        Math.max(0, boundary - right.cropBbox[startKey]),
    });
  } else if (right.contentBbox[endKey] <= left.contentBbox[startKey]) {
    const boundary = Math.round(
      (right.contentBbox[endKey] + left.contentBbox[startKey]) / 2,
    );
    choices.push({
      axis,
      leftBeforeRight: false,
      boundary,
      removed:
        Math.max(0, right.cropBbox[endKey] - boundary) +
        Math.max(0, boundary - left.cropBbox[startKey]),
    });
  }
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
  return [...components.values()].map((members) => {
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
  });
}

/**
 * @param {InternalRegion} region
 * @param {number} cropNumber
 * @returns {GroupReviewCropRegion}
 */
function serializeRegion(region, cropNumber) {
  const fragments = region.fragments.map((fragment) => ({
    reviewFragmentId: fragment.fragmentId,
    reviewStatus: fragment.status,
    reviewReasons: [...fragment.reasons],
    candidateIds: fragment.candidates.map((candidate) => candidate.id),
    bbox: { ...fragment.bbox },
    bbox1000: projectBoxToCrop1000(fragment.bbox, region.cropBbox),
  }));
  const candidates = region.fragments
    .flatMap((fragment) =>
      fragment.candidates.map((candidate) => ({
        candidateId: candidate.id,
        reviewFragmentId: fragment.fragmentId,
        reviewStatus: fragment.status,
        reviewOrder: candidate.order,
        paddleGroupId: candidate.paddleGroupId,
        paddleOrder: candidate.paddleOrder,
        paddleGroupSize: candidate.paddleGroupSize,
        bbox: { ...candidate.bbox },
        bbox1000: projectBoxToCrop1000(candidate.bbox, region.cropBbox),
      })),
    )
    .sort(
      (left, right) =>
        left.reviewFragmentId.localeCompare(right.reviewFragmentId) ||
        left.reviewOrder - right.reviewOrder ||
        left.candidateId - right.candidateId,
    );
  const confirmedFragmentIds = fragments
    .filter((fragment) => fragment.reviewStatus === "confirmed")
    .map((fragment) => fragment.reviewFragmentId);
  const deferredFragmentIds = fragments
    .filter((fragment) => fragment.reviewStatus === "deferred")
    .map((fragment) => fragment.reviewFragmentId);
  const cropBbox = { ...region.cropBbox };
  return {
    cropId: `C${String(cropNumber).padStart(3, "0")}`,
    reasons: [...region.reasons],
    confirmedFragmentIds,
    deferredFragmentIds,
    fragmentIds: fragments.map((fragment) => fragment.reviewFragmentId),
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    fragments,
    candidates,
    contentBbox: { ...region.contentBbox },
    cropBbox,
    cropRect: pageBoxToCropRect(cropBbox),
    padding: { ...region.padding },
  };
}

/** @param {GroupReviewCropPlan} plan @param {ReviewFragment[]} [sourceFragments] */
// eslint-disable-next-line max-lines-per-function -- single final invariant audit
function assertGroupReviewCropPlan(plan, sourceFragments) {
  if (
    !plan ||
    plan.version !== GROUP_REVIEW_CROP_PLAN_VERSION ||
    !Number.isInteger(plan.pageWidth) ||
    !Number.isInteger(plan.pageHeight) ||
    plan.pageWidth <= 0 ||
    plan.pageHeight <= 0 ||
    !Array.isArray(plan.regions)
  ) {
    throw new Error("Invalid group review crop plan.");
  }
  const fragmentIds = plan.regions.flatMap((region) => region.fragmentIds);
  const candidateIds = plan.regions.flatMap((region) => region.candidateIds);
  if (
    new Set(fragmentIds).size !== fragmentIds.length ||
    fragmentIds.length !== plan.fragmentCount
  ) {
    throw new Error("Review fragments are not a one-to-one crop partition.");
  }
  if (
    new Set(candidateIds).size !== candidateIds.length ||
    candidateIds.length !== plan.candidateCount
  ) {
    throw new Error("Review candidates are not a one-to-one crop partition.");
  }
  if (sourceFragments) {
    const expectedFragments = sourceFragments
      .map((fragment) => fragment.fragmentId)
      .sort();
    const expectedCandidates = sourceFragments
      .flatMap((fragment) =>
        fragment.candidates.map((candidate) => candidate.id),
      )
      .sort((left, right) => left - right);
    if (!sameArray([...fragmentIds].sort(), expectedFragments)) {
      throw new Error("Review fragment coverage changed while planning crops.");
    }
    if (
      !sameArray(
        [...candidateIds].sort((left, right) => left - right),
        expectedCandidates,
      )
    ) {
      throw new Error(
        "Review candidate coverage changed while planning crops.",
      );
    }
  }
  for (const region of plan.regions) {
    const contentTrimAllowed = region.reasons.some(
      (reason) =>
        reason === "narrow_content_seam" || reason === "display_priority_clip",
    );
    assertBoxInsidePage(
      region.contentBbox,
      plan.pageWidth,
      plan.pageHeight,
      `${region.cropId}.contentBbox`,
    );
    assertBoxInsidePage(
      region.cropBbox,
      plan.pageWidth,
      plan.pageHeight,
      `${region.cropId}.cropBbox`,
    );
    if (
      !contentTrimAllowed &&
      !boxContains(region.cropBbox, region.contentBbox)
    ) {
      throw new Error(`${region.cropId} trims review content.`);
    }
    const exactContent = unionBoxes(
      region.candidates.map((candidate) => candidate.bbox),
    );
    if (!sameBox(exactContent, region.contentBbox)) {
      throw new Error(`${region.cropId} content bbox is not an exact union.`);
    }
    const fragmentCandidateIds = region.fragments.flatMap(
      (fragment) => fragment.candidateIds,
    );
    if (
      !sameArray(
        [...fragmentCandidateIds].sort((left, right) => left - right),
        [...region.candidateIds].sort((left, right) => left - right),
      )
    ) {
      throw new Error(`${region.cropId} fragment candidate coverage changed.`);
    }
    for (const candidate of region.candidates) {
      if (
        !boxContains(region.cropBbox, candidate.bbox) &&
        (!contentTrimAllowed ||
          boxIntersectionArea(region.cropBbox, candidate.bbox) <= 0)
      ) {
        throw new Error(
          `${region.cropId} trims candidate ${candidate.candidateId}.`,
        );
      }
      assertBbox1000(candidate.bbox1000, `${region.cropId}.candidate`);
    }
    for (const fragment of region.fragments) {
      const members = region.candidates.filter(
        (candidate) => candidate.reviewFragmentId === fragment.reviewFragmentId,
      );
      if (
        !sameBox(
          unionBoxes(members.map((candidate) => candidate.bbox)),
          fragment.bbox,
        )
      ) {
        throw new Error(
          `${region.cropId} fragment ${fragment.reviewFragmentId} is not an exact union.`,
        );
      }
      assertBbox1000(fragment.bbox1000, `${region.cropId}.fragment`);
    }
  }
  for (let leftIndex = 0; leftIndex < plan.regions.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < plan.regions.length;
      rightIndex += 1
    ) {
      if (
        boxIntersectionArea(
          plan.regions[leftIndex].cropBbox,
          plan.regions[rightIndex].cropBbox,
        ) > 0
      ) {
        throw new Error("Final group review crop rectangles overlap.");
      }
    }
  }
}

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

/**
 * @param {string[]} values
 */
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

/**
 * @param {PageBox} left
 * @param {PageBox} right
 * @param {"x"|"y"} axis
 */
function axisGap(left, right, axis) {
  const start = /** @type {"x1"|"y1"} */ (`${axis}1`);
  const end = /** @type {"x2"|"y2"} */ (`${axis}2`);
  return Math.max(
    0,
    Math.max(left[start], right[start]) - Math.min(left[end], right[end]),
  );
}

/**
 * @param {PageBox} left
 * @param {PageBox} right
 * @param {"x"|"y"} axis
 */
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

/** @param {string} reason @returns {GroupReviewImageResult} */
function imageFallback(reason) {
  return { crops: [], fallbackReason: reason };
}

module.exports = {
  GROUP_REVIEW_CROP_PLAN_VERSION,
  assertGroupReviewCropPlan,
  buildGroupReviewCropImageVariants,
  buildGroupReviewCropPlan,
  projectBoxToCrop1000,
};
