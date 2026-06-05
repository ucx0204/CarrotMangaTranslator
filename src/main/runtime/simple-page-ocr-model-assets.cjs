const path = require("node:path");

const { PADDLE_OCR_MODEL_DOWNLOADS } = require("./simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const { buildHfResolveUrl } = require("./simple-page-download-utils.cjs");
const { safeHfRelativePath } = require("./simple-page-cache-paths.cjs");
const { resolveOcrRuntimeDir } = require("./simple-page-ocr-runtime-config.cjs");

function collectRequiredPaddleOcrModelDownloads(options = {}, runtime = null) {
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const endpoint = String(runtimeOverrideEnv("PADDLE_PDX_HUGGING_FACE_ENDPOINT", options) || "https://huggingface.co").replace(/\/+$/, "");
  const tasks = [];
  for (const model of PADDLE_OCR_MODEL_DOWNLOADS) {
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
        completeTitle: "Paddle OCR 모델 파일 다운로드 완료"
      });
    }
  }
  return tasks;
}

function resolvePaddleOcrModelCacheDir(runtimeDir, modelName) {
  return path.join(runtimeDir, "paddlex-cache", "official_models", modelName);
}

module.exports = {
  collectRequiredPaddleOcrModelDownloads,
  resolvePaddleOcrModelCacheDir
};
