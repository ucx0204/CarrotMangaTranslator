// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { keepOcrBatchArtifacts?: unknown }} OcrBboxOptions */

/**
 * @param {{
 *   existsSync: (path: string) => boolean;
 *   readFileSync: (path: string, encoding: "utf8") => string;
 *   rm: (path: string, options: { force: true }) => Promise<void>;
 *   safeCleanup: (label: string, cleanup: () => void | Promise<void>) => Promise<void>;
 *   runtimeOverrideEnv: (name: string, options?: RuntimeOptions) => unknown;
 * }} dependencies
 */
function createOcrBatchFiles(dependencies) {
  /** @param {string} outputPath */
  function readCompletedOcrBatchOutputPayload(outputPath) {
    if (!dependencies.existsSync(outputPath)) {
      return null;
    }
    try {
      return JSON.parse(dependencies.readFileSync(outputPath, "utf8"));
    } catch (_error) {
      return null;
    }
  }

  /** @param {string} outputPath */
  function readOcrBatchOutputPayload(outputPath) {
    return dependencies.existsSync(outputPath)
      ? JSON.parse(dependencies.readFileSync(outputPath, "utf8"))
      : null;
  }

  /** @param {string} batchPath @param {string} progressPath @param {OcrBboxOptions} [options] */
  async function cleanupOcrBatchControlFiles(
    batchPath,
    progressPath,
    options = {},
  ) {
    if (shouldKeepArtifacts(options)) {
      return;
    }
    await Promise.all([
      dependencies.safeCleanup("remove OCR batch request file", () =>
        dependencies.rm(batchPath, { force: true }),
      ),
      dependencies.safeCleanup("remove OCR batch progress file", () =>
        dependencies.rm(progressPath, { force: true }),
      ),
    ]);
  }

  /** @param {OcrBboxOptions} options */
  function shouldKeepArtifacts(options) {
    return Boolean(
      options.keepOcrBatchArtifacts ||
      isTruthy(
        dependencies.runtimeOverrideEnv(
          "MANGA_TRANSLATOR_KEEP_OCR_BATCH_ARTIFACTS",
          options,
        ),
      ),
    );
  }

  return {
    cleanupOcrBatchControlFiles,
    readCompletedOcrBatchOutputPayload,
    readOcrBatchOutputPayload,
  };
}

/** @param {unknown} value */
function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

module.exports = { createOcrBatchFiles };
