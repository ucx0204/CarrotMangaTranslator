// @ts-check
const { stat, unlink } = require("node:fs/promises");
const path = require("node:path");
const { resolveFfmpegPath } = require("../simple-page-runtime-paths.cjs");
const { createImageDetailedError } = require("./image-file-errors.cjs");
const {
  IMAGE_PROCESS_TERMINATION_GRACE_MS,
  runImageFfmpegProcess,
} = require("./image-file-process.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { ffmpegPath?: string | null; maxPixels: number; timeoutMs: number }} ImageValidationOptions */
/** @typedef {ImageValidationOptions & { maxOutputBytes: number }} ImageConversionOptions */
/** @typedef {{ executable: string; args: string[] }} ImageCommandSpec */
/** @typedef {{ spawn?: typeof import("node:child_process").spawn; terminate?: typeof import("../simple-page-shell-utils.cjs").terminateChildProcessTree }} ImageProcessDependencies */

/**
 * @param {string} filePath
 * @param {ImageValidationOptions} options
 * @param {ImageProcessDependencies} [dependencies]
 * @returns {Promise<void>}
 */
async function validateImageFileWithFfmpeg(
  filePath,
  options,
  dependencies = {},
) {
  assertValidationOptions(options);
  const command = buildImageValidationCommand(filePath, options);
  await runImageFfmpegProcess(command, options, dependencies);
}

/**
 * @param {string} filePath
 * @param {string} outputPath
 * @param {ImageConversionOptions} options
 * @param {ImageProcessDependencies} [dependencies]
 * @returns {Promise<void>}
 */
async function convertImageToPngFileWithFfmpeg(
  filePath,
  outputPath,
  options,
  dependencies = {},
) {
  assertConversionOptions(options);
  const command = buildImageConversionCommand(filePath, outputPath, options);
  try {
    await runImageFfmpegProcess(command, options, dependencies);
    await assertConvertedOutput(outputPath, options.maxOutputBytes);
  } catch (error) {
    throw await cleanupFailedOutput(outputPath, error);
  }
}

/**
 * @param {string} filePath
 * @param {ImageValidationOptions} options
 * @returns {ImageCommandSpec}
 */
function buildImageValidationCommand(filePath, options) {
  assertValidationOptions(options);
  return {
    executable: resolveFfmpegPath(options),
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-max_pixels",
      String(options.maxPixels),
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-f",
      "null",
      "-",
    ],
  };
}

/**
 * @param {string} filePath
 * @param {string} outputPath
 * @param {ImageConversionOptions} options
 * @returns {ImageCommandSpec}
 */
function buildImageConversionCommand(filePath, outputPath, options) {
  assertConversionOptions(options);
  return {
    executable: resolveFfmpegPath(options),
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-max_pixels",
      String(options.maxPixels),
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-c:v",
      "png",
      "-f",
      "image2",
      "-fs",
      String(options.maxOutputBytes),
      "-n",
      outputPath,
    ],
  };
}

/** @param {string} outputPath @param {number} maxOutputBytes */
async function assertConvertedOutput(outputPath, maxOutputBytes) {
  const info = await stat(outputPath);
  if (!info.isFile() || info.size < 1) {
    throw createImageDetailedError(
      "ffmpeg image conversion produced no output.",
      {
        output: path.basename(outputPath),
      },
    );
  }
  if (info.size > maxOutputBytes) {
    throw createImageDetailedError(
      "ffmpeg normalized image exceeded the output limit.",
      {
        output: path.basename(outputPath),
        outputBytes: info.size,
        maxOutputBytes,
      },
    );
  }
}

/** @param {string} outputPath @param {unknown} originalError */
async function cleanupFailedOutput(outputPath, originalError) {
  try {
    await unlink(outputPath);
    return originalError;
  } catch (cleanupError) {
    if (isNodeErrorWithCode(cleanupError, "ENOENT")) {
      return originalError;
    }
    if (isAbortError(originalError)) {
      const abortError = /** @type {Error & { cleanupErrors?: unknown[] }} */ (
        originalError
      );
      abortError.cleanupErrors = [cleanupError];
      return abortError;
    }
    return new AggregateError(
      [originalError, cleanupError],
      "Image conversion failed and the partial output could not be removed.",
    );
  }
}

/** @param {ImageValidationOptions} options */
function assertValidationOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Image validation options are required.");
  }
  assertPositiveSafeInteger(options.maxPixels, "maxPixels");
  assertPositiveSafeInteger(options.timeoutMs, "timeoutMs");
}

/** @param {ImageConversionOptions} options */
function assertConversionOptions(options) {
  assertValidationOptions(options);
  assertPositiveSafeInteger(options.maxOutputBytes, "maxOutputBytes");
}

/** @param {unknown} value @param {string} label */
function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

/** @param {unknown} error */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError",
  );
}

/** @param {unknown} error @param {string} code */
function isNodeErrorWithCode(error, code) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code,
  );
}

module.exports = {
  IMAGE_PROCESS_TERMINATION_GRACE_MS,
  buildImageConversionCommand,
  buildImageValidationCommand,
  convertImageToPngFileWithFfmpeg,
  runImageFfmpegProcess,
  validateImageFileWithFfmpeg,
};
