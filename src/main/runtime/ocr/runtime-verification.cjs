// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {{ ok: boolean; message: string; error?: unknown }} ImportCheckResult */

const { existsSync, readFileSync } = require("node:fs");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { OCR_INSTALL_MARKER_FILE } = require("../simple-page-defaults.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  isOcrGpuRequested,
  isOcrTransformersRuntime,
  resolveOcrGpuBackend,
  resolveOcrInstallSignature,
  resolveOcrRuntimeDir,
  resolvePaddleOcrImportCheckTimeoutMs,
} = require("../simple-page-ocr-runtime-config.cjs");
const { createDetailedError } = require("./host-services.cjs");
const {
  quoteCommandArg,
  runShellCommand,
} = require("../simple-page-shell-utils.cjs");
const { isTruthy } = require("./config-values.cjs");

/** @param {string} pythonPath @param {RuntimeOptions} [options] @returns {Promise<boolean>} */
async function canImportPaddleOcr(pythonPath, options = {}) {
  return (await checkPaddleOcrImport(pythonPath, options)).ok;
}

/** @param {string} pythonPath @param {RuntimeOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @returns {Promise<ImportCheckResult>} */
async function checkPaddleOcrImport(pythonPath, options = {}, runtime = null) {
  try {
    await runShellCommand(
      `${quoteCommandArg(pythonPath)} -c ${quoteCommandArg(buildPaddleOcrImportCheckScript(options))}`,
      {
        timeoutMs: resolvePaddleOcrImportCheckTimeoutMs(options),
        env: buildOcrRuntimeEnv(options, {
          runtimeDir: runtime?.runtimeDir || resolveOcrRuntimeDir(options),
          packageDir: runtime?.packageDir,
          includePackageDir: runtime?.includePackageDir,
        }),
        signal: options.abortSignal,
        timeoutMessage: "Paddle OCR runtime verification timed out.",
      },
    );
    return { ok: true, message: "" };
  } catch (error) {
    if (options.abortSignal?.aborted || isAbortError(error)) {
      throw error;
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      error,
    };
  }
}

/** @param {unknown} error @returns {boolean} */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {{ name?: unknown }} */ (error).name === "AbortError",
  );
}

/** @param {string} message @param {Record<string, unknown>} [detail] @param {unknown} [cause] @returns {Error} */
function createOcrRuntimeError(message, detail = {}, cause) {
  return createDetailedError(
    message,
    {
      ...detail,
      nonRetriable: true,
      failureCategory: "ocr-runtime",
    },
    cause,
  );
}

/** @param {string} packageDir @param {string} runtimeVariant @param {RuntimeOptions} [options] @returns {boolean} */
function hasOcrInstallMarker(packageDir, runtimeVariant, options = {}) {
  try {
    const marker = JSON.parse(
      readFileSync(path.join(packageDir, OCR_INSTALL_MARKER_FILE), "utf8"),
    );
    return (
      marker?.runtimeVariant === runtimeVariant &&
      marker?.packageSignature === resolveOcrInstallSignature(options)
    );
  } catch (_error) {
    return false;
  }
}

/** @param {string} packageDir @param {Record<string, unknown>} payload @returns {Promise<void>} */
async function writeOcrInstallMarker(packageDir, payload) {
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    path.join(packageDir, OCR_INSTALL_MARKER_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/** @param {string} packageDir @param {RuntimeOptions} [options] @returns {boolean} */
function hasExpectedOcrPackages(packageDir, options = {}) {
  if (!packageDir || !existsSync(packageDir)) {
    return false;
  }
  const backend = resolveOcrGpuBackend(options);
  if (isOcrTransformersRuntime(options)) {
    return hasPackageDirectories(packageDir, [
      "torch",
      "torchvision",
      "transformers",
      "tokenizers",
      "paddlex",
      "paddleocr",
      "safetensors",
    ]);
  }
  const required = ["paddle", "paddleocr", "paddlex"];
  if (isOcrGpuRequested(options) && backend === "cuda") {
    required.push("nvidia");
  }
  return hasPackageDirectories(packageDir, required);
}

/** @param {string} packageDir @param {string[]} names @returns {boolean} */
function hasPackageDirectories(packageDir, names) {
  return names.every((name) => existsSync(path.join(packageDir, name)));
}

module.exports = {
  canImportPaddleOcr,
  checkPaddleOcrImport,
  createOcrRuntimeError,
  hasExpectedOcrPackages,
  hasOcrInstallMarker,
  isTruthy,
  writeOcrInstallMarker,
};
