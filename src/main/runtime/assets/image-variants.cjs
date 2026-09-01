// @ts-check
const { isOpenAICodexProvider } = require("../simple-page-model-config.cjs");
const { readPositiveInteger } = require("../simple-page-prompts.cjs");
const {
  buildEnhancedVariant,
  buildEnhancedVariantFailureDetail,
} = require("./image-enhancement.cjs");
const {
  fileToModelAsset,
  resolveImageSize,
} = require("./image-source-assets.cjs");
const { buildOpenAIVisionVariant } = require("./openai-vision-variant.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { imagePath: string; outputDir: string; includeEnhancedVariant?: boolean | null; label?: string | null; regionContextImagePath?: string | null; regionContextImageWidth?: unknown; regionContextImageHeight?: unknown; soundEffectTargetCropPath?: string | null; soundEffectTargetCropWidth?: unknown; soundEffectTargetCropHeight?: unknown }} ImageVariantOptions */
/** @typedef {{ role: string; path: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number; mime?: string; convertedFromMime?: string | null; dataUrl?: string }} ImageVariant */
/** @typedef {{ name: string; message: string; imagePath?: string; format?: string | null; reason: string; cause?: unknown }} ImageVariantDiagnostic */

/** @param {ImageVariantOptions} options */
async function prepareImageVariants(options) {
  const sourceSize = resolveImageSize(options);
  const variants = await buildBaseVariants(options, sourceSize);
  appendRegionContext(variants, options);
  appendSoundEffectTargetCrop(variants, options);
  const diagnostics = await appendEnhancedVariant(
    variants,
    options,
    sourceSize,
  );
  return {
    imageVariants: await Promise.all(
      variants.map((variant) => hydrateVariant(variant, options)),
    ),
    diagnostics,
  };
}

/** @param {ImageVariant[]} variants @param {ImageVariantOptions} options */
function appendSoundEffectTargetCrop(variants, options) {
  const cropPath = String(options.soundEffectTargetCropPath || "").trim();
  if (!cropPath) return;
  variants.push({
    role: "sound-effect-target-crop",
    path: cropPath,
    width: readPositiveInteger(options.soundEffectTargetCropWidth) || undefined,
    height:
      readPositiveInteger(options.soundEffectTargetCropHeight) || undefined,
  });
}

/** @param {ImageVariantOptions} options @param {{ width: number; height: number }} sourceSize @returns {Promise<ImageVariant[]>} */
async function buildBaseVariants(options, sourceSize) {
  if (isOpenAICodexProvider(options)) {
    const variant = await buildOpenAIVisionVariant({
      ...options,
      imageWidth: sourceSize.width,
      imageHeight: sourceSize.height,
    });
    return [markSoundEffectContextRole(variant, options)];
  }
  return [
    markSoundEffectContextRole(
      {
        role: "original",
        path: options.imagePath,
        width: sourceSize.width,
        height: sourceSize.height,
      },
      options,
    ),
  ];
}

/** @param {ImageVariant} variant @param {ImageVariantOptions} options */
function markSoundEffectContextRole(variant, options) {
  return options.soundEffectTranslationMode === true
    ? { ...variant, role: "sound-effect-page-context" }
    : variant;
}

/** @param {ImageVariant[]} variants @param {ImageVariantOptions} options */
function appendRegionContext(variants, options) {
  const contextPath = String(options.regionContextImagePath || "").trim();
  if (!contextPath) return;
  const width =
    readPositiveInteger(options.regionContextImageWidth) || undefined;
  const height =
    readPositiveInteger(options.regionContextImageHeight) || undefined;
  variants.push({
    role: "full-page-context",
    path: contextPath,
    width,
    height,
    originalWidth: width,
    originalHeight: height,
  });
}

/** @param {ImageVariant[]} variants @param {ImageVariantOptions} options @param {{ width: number; height: number }} sourceSize @returns {Promise<ImageVariantDiagnostic[]>} */
async function appendEnhancedVariant(variants, options, sourceSize) {
  if (!options.includeEnhancedVariant) return [];
  try {
    variants.push({
      role: "enhanced",
      path: await buildEnhancedVariant(options),
      width: sourceSize.width,
      height: sourceSize.height,
      originalWidth: sourceSize.width,
      originalHeight: sourceSize.height,
    });
    return [];
  } catch (error) {
    const diagnostic = buildEnhancedVariantFailureDetail(error, options);
    process.stderr.write(
      `[runtime:${options.label}:warn] enhanced variant unavailable; continuing with original image only (${diagnostic.message})\n`,
    );
    return [diagnostic];
  }
}

/** @param {ImageVariant} variant @param {ImageVariantOptions} options */
async function hydrateVariant(variant, options) {
  return { ...variant, ...(await fileToModelAsset(variant.path, options)) };
}

module.exports = { prepareImageVariants };
