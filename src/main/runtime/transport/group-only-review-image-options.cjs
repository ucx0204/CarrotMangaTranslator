// @ts-check

/**
 * Reuse the already-hydrated PNG only for WebP. Other formats retain direct
 * path decoding, so the compatibility path cannot perturb normal pages.
 *
 * @param {{path:string;dataUrl?:unknown;convertedFromMime?:unknown}} original
 */
function buildReviewCropImageOptions(original) {
  const hydratedWebp =
    original.convertedFromMime === "image/webp" &&
    typeof original.dataUrl === "string" &&
    original.dataUrl.startsWith("data:image/png;base64,");
  return {
    imagePath: original.path,
    ...(hydratedWebp ? { sourceImageDataUrl: original.dataUrl } : {}),
  };
}

module.exports = { buildReviewCropImageOptions };
