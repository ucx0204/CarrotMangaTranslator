// @ts-check

const {
  resolveElectronNativeImage,
} = require("../assets/image-source-assets.cjs");
const {
  groupReviewImageError,
  isExpectedGroupReviewImageFailure,
} = require("./review-errors.cjs");
const {
  assertGroupReviewCropPlan,
} = require("./group-review-crop-serialization.cjs");

/** @typedef {import("./group-review-crop-types").GroupReviewCropRegion} GroupReviewCropRegion */
/** @typedef {import("./group-review-crop-types").GroupReviewCropPlan} GroupReviewCropPlan */
/** @typedef {import("./group-review-crop-types").PreparedGroupReviewCrop} PreparedGroupReviewCrop */
/** @typedef {import("./group-review-crop-types").GroupReviewImageResult} GroupReviewImageResult */
/** @typedef {import("./group-review-crop-types").GroupReviewCropOptions} GroupReviewCropOptions */
/** @typedef {import("./group-review-crop-types").NativeImageLike} NativeImageLike */
/** @typedef {import("./group-review-crop-types").NativeImageModule} NativeImageModule */

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
    if (!isExpectedGroupReviewImageFailure(error)) throw error;
    return imageFallback(
      String(
        /** @type {Error & {code?:unknown}} */ (error).code ??
          "group-review-image-crop-build-failed",
      ).replace(/^group-review-image-/, ""),
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
  const source = decodeSourceImage(nativeImage, imagePath, options, plan);
  const crops = plan.regions.map((region) =>
    createPreparedImageCrop(source, imagePath, plan, region),
  );
  return { crops, fallbackReason: null };
}

/**
 * @param {NativeImageModule} nativeImage
 * @param {string} imagePath
 * @param {GroupReviewCropOptions} options
 * @param {GroupReviewCropPlan} plan
 */
function decodeSourceImage(nativeImage, imagePath, options, plan) {
  let decoded;
  const dataUrl = readSourceImageDataUrl(options.sourceImageDataUrl);
  let decodedFromDataUrl = false;
  try {
    if (dataUrl && typeof nativeImage.createFromDataURL === "function") {
      decoded = nativeImage.createFromDataURL(dataUrl);
      decodedFromDataUrl = true;
    } else {
      decoded = nativeImage.createFromPath(imagePath);
    }
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw groupReviewImageError(
      "source-decode-failed",
      "The source image could not be decoded.",
      error,
    );
  }
  return requireSourceImage(decoded, plan, decodedFromDataUrl);
}

/** @param {unknown} value */
function requireImagePath(value) {
  const imagePath = String(value ?? "").trim();
  if (!imagePath)
    throw groupReviewImageError(
      "missing-image-path",
      "Group review image path is missing.",
    );
  return imagePath;
}

/** @param {unknown} value */
function readSourceImageDataUrl(value) {
  const dataUrl = String(value ?? "").trim();
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl) ? dataUrl : null;
}

/** @param {NativeImageModule|null|undefined} injected */
function requireNativeImageModule(injected) {
  const nativeImage =
    injected ||
    /** @type {NativeImageModule|null} */ (
      /** @type {unknown} */ (resolveElectronNativeImage())
    );
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") {
    throw groupReviewImageError(
      "native-image-unavailable",
      "Electron nativeImage is unavailable.",
    );
  }
  return nativeImage;
}

/**
 * OCR coordinates may already have been normalized from the decoded source
 * dimensions into the page metadata frame. Only hydrated model assets are
 * allowed to resize into that same frame; direct path decoding keeps the
 * previous strict mismatch fallback.
 *
 * @param {NativeImageLike} source
 * @param {GroupReviewCropPlan} plan
 * @param {boolean} allowResize
 */
function requireSourceImage(source, plan, allowResize) {
  if (!source || source.isEmpty() || typeof source.crop !== "function") {
    throw groupReviewImageError(
      "source-decode-failed",
      "The source image could not be decoded.",
    );
  }
  const sourceSize = source.getSize?.();
  if (!sourceSize || sourceMatchesPlan(sourceSize, plan)) {
    return source;
  }
  if (allowResize) {
    return resizeSourceImage(source, plan);
  }
  throw sourceSizeMismatch();
}

/** @param {{width:number;height:number}} size @param {GroupReviewCropPlan} plan */
function sourceMatchesPlan(size, plan) {
  return size.width === plan.pageWidth && size.height === plan.pageHeight;
}

/** @param {NativeImageLike} source @param {GroupReviewCropPlan} plan */
function resizeSourceImage(source, plan) {
  if (typeof source.resize !== "function") {
    throw sourceSizeMismatch();
  }
  let resized;
  try {
    resized = source.resize({
      width: plan.pageWidth,
      height: plan.pageHeight,
      quality: "best",
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw groupReviewImageError(
      "source-resize-failed",
      "The hydrated source image could not be resized to the crop coordinate frame.",
      error,
    );
  }
  if (
    !resized ||
    resized.isEmpty() ||
    typeof resized.crop !== "function" ||
    (resized.getSize?.() && !sourceMatchesPlan(resized.getSize(), plan))
  ) {
    throw groupReviewImageError(
      "source-resize-failed",
      "The hydrated source image could not be resized to the crop coordinate frame.",
    );
  }
  return resized;
}

function sourceSizeMismatch() {
  return groupReviewImageError(
    "source-size-mismatch",
    "The source image size does not match the crop plan.",
  );
}

/**
 * @param {NativeImageLike} source
 * @param {string} imagePath
 * @param {GroupReviewCropPlan} plan
 * @param {GroupReviewCropRegion} region
 * @returns {PreparedGroupReviewCrop}
 */
function createPreparedImageCrop(source, imagePath, plan, region) {
  const cropped = cropNativeImage(source, region);
  const png = encodeCropPng(cropped, region.cropId);
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

/** @param {NativeImageLike} source @param {GroupReviewCropRegion} region */
function cropNativeImage(source, region) {
  let cropped;
  try {
    cropped = source.crop(region.cropRect);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw groupReviewImageError(
      `crop-decode-failed:${region.cropId}`,
      `Crop ${region.cropId} could not be decoded.`,
      error,
    );
  }
  if (!cropped || cropped.isEmpty()) {
    throw groupReviewImageError(
      `crop-decode-failed:${region.cropId}`,
      `Crop ${region.cropId} could not be decoded.`,
    );
  }
  return cropped;
}

/** @param {NativeImageLike} cropped @param {string} cropId */
function encodeCropPng(cropped, cropId) {
  let png;
  try {
    png = cropped.toPNG();
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw groupReviewImageError(
      `crop-png-failed:${cropId}`,
      `Crop ${cropId} could not be encoded as PNG.`,
      error,
    );
  }
  if (!Buffer.isBuffer(png) || png.length === 0) {
    throw groupReviewImageError(
      `crop-png-failed:${cropId}`,
      `Crop ${cropId} could not be encoded as PNG.`,
    );
  }
  return png;
}

/** @param {string} reason @returns {GroupReviewImageResult} */
function imageFallback(reason) {
  return { crops: [], fallbackReason: reason };
}

module.exports = { buildGroupReviewCropImageVariants };
