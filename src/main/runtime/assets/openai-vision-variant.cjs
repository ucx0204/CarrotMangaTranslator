// @ts-check
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  calculateOpenAIOriginalDetailSize,
} = require("../simple-page-image-utils.cjs");
const {
  resolveElectronNativeImage,
  resolveImageSize,
} = require("./image-source-assets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { imageHeight?: unknown; imagePath: string; imageWidth?: unknown; outputDir: string }} ImageVariantOptions */

/** @param {ImageVariantOptions} options */
async function buildOpenAIVisionVariant(options) {
  const sourceSize = resolveImageSize(options);
  const targetSize = calculateOpenAIOriginalDetailSize(
    sourceSize.width,
    sourceSize.height,
  );
  const base = buildVisionBase(sourceSize, targetSize);
  if (!hasValidSize(sourceSize) || !hasValidSize(targetSize))
    return originalVariant(options, sourceSize, base);
  if (
    targetSize.width === sourceSize.width &&
    targetSize.height === sourceSize.height
  ) {
    return { ...base, path: options.imagePath };
  }
  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage) return originalVariant(options, sourceSize, base);
  const image = nativeImage.createFromPath(options.imagePath);
  if (!image || image.isEmpty())
    return originalVariant(options, sourceSize, base);
  const outputPath = path.join(options.outputDir, "input-openai-vision.png");
  const resized = image.resize({ ...targetSize, quality: "best" });
  await mkdir(options.outputDir, { recursive: true });
  await writeFile(outputPath, resized.toPNG());
  return { ...base, path: outputPath };
}

/** @param {{ width: number; height: number }} source @param {{ width: number; height: number }} target */
function buildVisionBase(source, target) {
  return {
    role: "openai-vision",
    originalWidth: source.width,
    originalHeight: source.height,
    width: target.width || source.width,
    height: target.height || source.height,
  };
}

/** @param {{ width: number; height: number }} size */
function hasValidSize(size) {
  return Boolean(size.width && size.height);
}

/** @param {ImageVariantOptions} options @param {{ width: number; height: number }} source @param {Record<string, unknown>} base */
function originalVariant(options, source, base) {
  return {
    ...base,
    role: "original",
    path: options.imagePath,
    width: source.width,
    height: source.height,
  };
}

module.exports = { buildOpenAIVisionVariant };
