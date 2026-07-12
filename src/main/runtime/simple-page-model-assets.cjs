// @ts-check
const {
  resolveCachedConfiguredDraftModelPath,
  resolveCachedConfiguredMmprojPath,
  resolveCachedLlamaCppFile,
  resolveConfiguredMmprojUrl,
} = require("./model/hf-cache-assets.cjs");
const {
  inspectModelLaunch,
  isModelCached,
  resolveCachedModelAssets,
} = require("./model/model-launch-target.cjs");
const {
  collectRequiredHfDownloads,
} = require("./model/hf-model-download-tasks.cjs");
const {
  ensureHfModelAssetsDownloaded,
} = require("./model/hf-model-download.cjs");
const {
  ensureDefaultLlamaRuntimeDownloaded,
} = require("./model/llama-runtime-download.cjs");
const {
  ensurePaddleOcrModelAssetsDownloaded,
  isPaddleOcrModelAssetLoadFailure,
} = require("./model/paddle-model-download.cjs");
const {
  repairPaddleOcrModelAssetsCache,
} = require("./model/paddle-model-repair.cjs");

module.exports = {
  collectRequiredHfDownloads,
  ensureDefaultLlamaRuntimeDownloaded,
  ensureHfModelAssetsDownloaded,
  ensurePaddleOcrModelAssetsDownloaded,
  inspectModelLaunch,
  isPaddleOcrModelAssetLoadFailure,
  isModelCached,
  repairPaddleOcrModelAssetsCache,
  resolveCachedConfiguredDraftModelPath,
  resolveCachedConfiguredMmprojPath,
  resolveCachedLlamaCppFile,
  resolveCachedModelAssets,
  resolveConfiguredMmprojUrl,
};
