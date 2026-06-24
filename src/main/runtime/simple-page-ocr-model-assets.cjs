// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
const path = require("node:path");

const { PADDLE_OCR_MODEL_DOWNLOADS } = require("./simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const { buildHfResolveUrl } = require("./simple-page-download-utils.cjs");
const { safeHfRelativePath } = require("./simple-page-cache-paths.cjs");
const {
  isOcrGpuRequested,
  resolveOcrGpuBackend,
  resolveOcrRuntimeDir,
} = require("./simple-page-ocr-runtime-config.cjs");

const PADDLE_OCR_TEXTLINE_MODEL_FILES = [
  ".gitattributes",
  "README.md",
  "inference.json",
  "inference.pdiparams",
  "inference.yml",
];
const PADDLE_OCR_TEXTLINE_MODEL_DOWNLOADS = new Map(
  [
    "PP-OCRv6_medium_det",
    "PP-OCRv6_medium_rec",
    "PP-OCRv6_small_det",
    "PP-OCRv6_small_rec",
    "PP-OCRv6_tiny_det",
    "PP-OCRv6_tiny_rec",
  ].map((name) => [
    name,
    {
      name,
      repo: `PaddlePaddle/${name}`,
      files: PADDLE_OCR_TEXTLINE_MODEL_FILES,
    },
  ]),
);

/**
 * @param {RuntimeOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 */
function collectRequiredPaddleOcrModelDownloads(options = {}, runtime = null) {
  if (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  ) {
    return [];
  }
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const endpoint = String(
    runtimeOverrideEnv("PADDLE_PDX_HUGGING_FACE_ENDPOINT", options) ||
      "https://huggingface.co",
  ).replace(/\/+$/, "");
  const tasks = [];
  for (const model of resolveRequiredPaddleOcrModelDownloads(options)) {
    const modelDir = resolvePaddleOcrModelCacheDir(runtimeDir, model.name);
    for (const file of model.files) {
      tasks.push({
        kind: "paddle-ocr-model",
        label: `Paddle OCR ${model.name}`,
        repo: model.repo,
        file,
        url: buildHfResolveUrl(endpoint, model.repo, file),
        destination: path.join(modelDir, safeHfRelativePath(file)),
        progressPhase: "ocr_downloading",
        progressTitle: "Paddle OCR 모델 파일 다운로드 중",
        completeTitle: "Paddle OCR 모델 파일 다운로드 완료",
      });
    }
  }
  return tasks;
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {Array<{ name: string; repo: string; files: string[] }>}
 */
function resolveRequiredPaddleOcrModelDownloads(options = {}) {
  const textDetectionModelName =
    runtimeOverrideEnv(
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME",
      options,
    ) || readOptionString(options.ocrTextDetectionModelName);
  const textRecognitionModelName =
    runtimeOverrideEnv(
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME",
      options,
    ) || readOptionString(options.ocrTextRecognitionModelName);
  if (!textDetectionModelName && !textRecognitionModelName) {
    return PADDLE_OCR_MODEL_DOWNLOADS;
  }

  const models = [];
  for (const modelName of [textDetectionModelName, textRecognitionModelName]) {
    const model = PADDLE_OCR_TEXTLINE_MODEL_DOWNLOADS.get(modelName);
    if (model) {
      models.push(model);
    }
  }
  return models.length > 0 ? models : PADDLE_OCR_MODEL_DOWNLOADS;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readOptionString(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} runtimeDir
 * @param {string} modelName
 * @returns {string}
 */
function resolvePaddleOcrModelCacheDir(runtimeDir, modelName) {
  return path.join(runtimeDir, "paddlex-cache", "official_models", modelName);
}

module.exports = {
  collectRequiredPaddleOcrModelDownloads,
  resolvePaddleOcrModelCacheDir,
  resolveRequiredPaddleOcrModelDownloads,
};
