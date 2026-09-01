// @ts-check
const { rm } = require("node:fs/promises");
const path = require("node:path");
const {
  resolvePaddleOcrModelCacheDir,
} = require("../simple-page-ocr-model-assets.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  ensurePaddleOcrModelAssetsDownloaded,
} = require("./paddle-model-download.cjs");
const {
  isSafePaddleOcrModelCacheDir,
  resolvePaddleOcrModelNamesForRepair,
  truncateReason,
} = require("./paddle-model-validation.cjs");
const { assertPaddleLegacyOcrPipeline } = require("../ocr/engine-profile.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} ModelAssetOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */

/** @param {ModelAssetOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @param {unknown} [reason] */
async function repairPaddleOcrModelAssetsCache(
  options = {},
  runtime = null,
  reason = "",
) {
  assertPaddleLegacyOcrPipeline(options, "Paddle OCR model repair");
  const runtimeDir = resolveRuntimeDir(options, runtime);
  const names = resolvePaddleOcrModelNamesForRepair(
    String(reason ?? ""),
    options,
  );
  emitRepairStart(options, names, reason);
  for (const modelName of names) {
    const modelDir = resolvePaddleOcrModelCacheDir(runtimeDir, modelName);
    assertSafeModelDir(runtimeDir, modelDir, modelName);
    await safeCleanup("remove corrupt cached HF model directory", () =>
      rm(modelDir, { recursive: true, force: true }),
    );
  }
  await ensurePaddleOcrModelAssetsDownloaded(options, runtime);
}

/** @param {ModelAssetOptions} options @param {OcrRuntimeLayout | null} runtime */
function resolveRuntimeDir(options, runtime) {
  return (
    runtime?.runtimeDir ||
    options.ocrRuntimeDir ||
    path.join(options.workingDir || process.cwd(), "ocr-runtime")
  );
}

/** @param {ModelAssetOptions} options @param {string[]} names @param {unknown} reason */
function emitRepairStart(options, names, reason) {
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 캐시 복구 중",
    names.join(", "),
    {
      progressMode: "log-only",
      installLogLine: `Paddle OCR 모델 캐시를 다시 준비합니다. reason=${truncateReason(String(reason ?? ""))}`,
    },
  );
}

/** @param {string} runtimeDir @param {string} modelDir @param {string} modelName */
function assertSafeModelDir(runtimeDir, modelDir, modelName) {
  if (isSafePaddleOcrModelCacheDir(runtimeDir, modelDir)) return;
  throw createDetailedError("Unsafe Paddle OCR model cache path.", {
    runtimeDir,
    modelDir,
    modelName,
  });
}

module.exports = { repairPaddleOcrModelAssetsCache };
