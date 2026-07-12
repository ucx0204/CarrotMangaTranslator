// @ts-check
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  enhanceBitmapBuffer,
  getScaledSize,
} = require("../simple-page-image-utils.cjs");
const { readPositiveInteger } = require("../simple-page-prompts.cjs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { enhancedContrast?: unknown; enhancedMaxLongSide?: unknown; imagePath: string; outputDir: string }} ImageVariantOptions */
/** @typedef {{ width: number; height: number }} ImageSize */
/** @typedef {{ isEmpty(): boolean; getSize(): ImageSize; resize(options: { width: number; height: number; quality?: "good" | "better" | "best" }): NativeImageInstance; toBitmap(): Buffer; toPNG(): Buffer }} NativeImageInstance */
/** @typedef {{ createFromPath(filePath: string): NativeImageInstance; createFromBitmap(buffer: Buffer, size: ImageSize): NativeImageInstance }} NativeImageModule */

/** @param {ImageVariantOptions} options @param {NativeImageModule} nativeImage */
async function buildEnhancedVariantWithElectron(options, nativeImage) {
  const outputPath = path.join(options.outputDir, "input-enhanced.png");
  const image = requireDecodedImage(nativeImage, options, outputPath);
  const sourceSize = requireImageSize(image, options, outputPath);
  const scaled = resolveEnhancedSize(sourceSize, options.enhancedMaxLongSide);
  const resized = requireResizedImage(
    image,
    sourceSize,
    scaled,
    options,
    outputPath,
  );
  const bitmap = requireBitmap(
    resized,
    sourceSize,
    scaled,
    options,
    outputPath,
  );
  const enhancedBitmap = enhanceBitmapBuffer(
    bitmap,
    resolveContrast(options.enhancedContrast),
    true,
  );
  const enhancedImage = requireEnhancedImage(
    nativeImage,
    enhancedBitmap,
    scaled,
    sourceSize,
    options,
    outputPath,
  );
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, enhancedImage.toPNG());
  return outputPath;
}

/** @param {NativeImageModule} nativeImage @param {ImageVariantOptions} options @param {string} outputPath */
function requireDecodedImage(nativeImage, options, outputPath) {
  const image = nativeImage.createFromPath(options.imagePath);
  if (image && !image.isEmpty()) return image;
  throw imageError(
    "Electron nativeImage could not decode the source image.",
    options,
    outputPath,
  );
}

/** @param {NativeImageInstance} image @param {ImageVariantOptions} options @param {string} outputPath */
function requireImageSize(image, options, outputPath) {
  const sourceSize = image.getSize();
  if (sourceSize.width && sourceSize.height) return sourceSize;
  throw imageError(
    "Electron nativeImage returned an empty size for the source image.",
    options,
    outputPath,
    { sourceSize },
  );
}

/** @param {ImageSize} sourceSize @param {unknown} configuredMax */
function resolveEnhancedSize(sourceSize, configuredMax) {
  const maxLongSide =
    readPositiveInteger(configuredMax) ||
    Math.max(sourceSize.width, sourceSize.height);
  return getScaledSize(sourceSize.width, sourceSize.height, maxLongSide);
}

/** @param {NativeImageInstance} image @param {ImageSize} sourceSize @param {ImageSize} scaled @param {ImageVariantOptions} options @param {string} outputPath */
function requireResizedImage(image, sourceSize, scaled, options, outputPath) {
  const unchanged =
    scaled.width === sourceSize.width && scaled.height === sourceSize.height;
  const resized = unchanged
    ? image
    : image.resize({ ...scaled, quality: "best" });
  if (resized && !resized.isEmpty()) return resized;
  throw imageError(
    "Electron nativeImage resize returned an empty image.",
    options,
    outputPath,
    { sourceSize, scaled },
  );
}

/** @param {NativeImageInstance} image @param {ImageSize} sourceSize @param {ImageSize} scaled @param {ImageVariantOptions} options @param {string} outputPath */
function requireBitmap(image, sourceSize, scaled, options, outputPath) {
  const bitmap = image.toBitmap();
  if (bitmap && bitmap.length > 0) return bitmap;
  throw imageError(
    "Electron nativeImage returned an empty bitmap buffer.",
    options,
    outputPath,
    { sourceSize, scaled },
  );
}

/** @param {unknown} value */
function resolveContrast(value) {
  const contrast = Number(value);
  return Number.isFinite(contrast) ? contrast : 1;
}

/** @param {NativeImageModule} nativeImage @param {Buffer} bitmap @param {ImageSize} scaled @param {ImageSize} sourceSize @param {ImageVariantOptions} options @param {string} outputPath */
function requireEnhancedImage(
  nativeImage,
  bitmap,
  scaled,
  sourceSize,
  options,
  outputPath,
) {
  const image = nativeImage.createFromBitmap(bitmap, scaled);
  if (image && !image.isEmpty()) return image;
  throw imageError(
    "Electron nativeImage could not create the enhanced bitmap.",
    options,
    outputPath,
    { sourceSize, scaled },
  );
}

/** @param {string} message @param {ImageVariantOptions} options @param {string} outputPath @param {Record<string, unknown>} [extra] */
function imageError(message, options, outputPath, extra = {}) {
  return createDetailedError(message, {
    imagePath: options.imagePath,
    outputPath,
    format: path.extname(options.imagePath).toLowerCase(),
    ...extra,
  });
}

module.exports = { buildEnhancedVariantWithElectron };
