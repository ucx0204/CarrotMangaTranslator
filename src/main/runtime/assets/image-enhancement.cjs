// @ts-check
const path = require("node:path");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");
const {
  buildEnhancedVariantWithElectron,
} = require("./electron-image-enhancement.cjs");
const {
  buildEnhancedVariantWithPowerShell,
} = require("./powershell-image-enhancement.cjs");
const { resolveElectronNativeImage } = require("./image-source-assets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { imagePath: string; outputDir: string }} ImageVariantOptions */

/** @param {unknown} error @param {Partial<ImageVariantOptions>} [options] */
function buildEnhancedVariantFailureDetail(error, options = {}) {
  const base = {
    imagePath: options.imagePath,
    format: path.extname(options.imagePath || "").toLowerCase() || null,
    reason: "enhanced-variant-unavailable",
  };
  return error instanceof Error
    ? { ...base, name: error.name, message: error.message, cause: error.cause }
    : { ...base, name: "Error", message: String(error) };
}

/** @param {ImageVariantOptions} options */
async function buildEnhancedVariant(options) {
  const electronResult = await tryElectronEnhancement(options);
  if (electronResult.path) return electronResult.path;
  try {
    return await buildEnhancedVariantWithPowerShell(options);
  } catch (error) {
    if (!electronResult.error) throw error;
    throw createDetailedError(
      "Enhanced variant generation failed in both Electron and PowerShell pipelines.",
      {
        imagePath: options.imagePath,
        outputDir: options.outputDir,
        electronError: electronResult.error,
      },
      error,
    );
  }
}

/** @param {ImageVariantOptions} options */
async function tryElectronEnhancement(options) {
  const nativeImage = resolveElectronNativeImage();
  if (!nativeImage) return { path: null, error: null };
  try {
    return {
      path: await buildEnhancedVariantWithElectron(options, nativeImage),
      error: null,
    };
  } catch (error) {
    return { path: null, error };
  }
}

module.exports = { buildEnhancedVariant, buildEnhancedVariantFailureDetail };
