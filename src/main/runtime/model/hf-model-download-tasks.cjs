// @ts-check
const { resolveManagedHfFilePath } = require("../simple-page-cache-paths.cjs");
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
} = require("../simple-page-model-config.cjs");
const { inspectModelLaunch } = require("./model-launch-target.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */
/** @typedef {{ kind: string; label: string; repo?: string; file: string; url: string; destination: string; progressPhase?: string; progressTitle?: string; completeTitle?: string }} DownloadTask */
/** @typedef {ReturnType<typeof inspectModelLaunch>} ModelLaunchTarget */

/** @param {ModelAssetOptions} [options] @param {ModelLaunchTarget} [target] @returns {DownloadTask[]} */
function collectRequiredHfDownloads(
  options = {},
  target = inspectModelLaunch(options),
) {
  if (["openai-codex", "openai-api"].includes(target.launchMode)) return [];
  return [
    buildModelDownload(options, target),
    buildMmprojDownload(options, target),
    buildDraftDownload(options, target),
  ].filter(isDownloadTask);
}

/** @param {unknown} value @returns {value is DownloadTask} */
function isDownloadTask(value) {
  return Boolean(value);
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {DownloadTask | null} */
function buildModelDownload(options, target) {
  if (target.launchMode === "local" || target.modelPath) return null;
  const repo = resolveConfiguredModelRepo(options);
  const file = resolveConfiguredModelFile(options);
  return buildTask(
    "model",
    "Gemma 모델",
    repo,
    file,
    hfUrl(repo, file),
    options,
  );
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {DownloadTask | null} */
function buildMmprojDownload(options, target) {
  if (!target.mmprojUrl || target.mmprojPath) return null;
  return buildTask(
    "mmproj",
    "Gemma vision mmproj",
    resolveConfiguredMmprojRepo(options),
    resolveConfiguredMmprojFile(options),
    target.mmprojUrl,
    options,
  );
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {DownloadTask | null} */
function buildDraftDownload(options, target) {
  if (!options.useDraft || !target.draftModelUrl || target.draftModelPath)
    return null;
  return buildTask(
    "draft",
    "Gemma draft 모델",
    resolveConfiguredDraftModelRepo(options),
    resolveConfiguredDraftModelFile(options),
    target.draftModelUrl,
    options,
  );
}

/** @param {string} kind @param {string} label @param {string} repo @param {string} file @param {string} url @param {ModelAssetOptions} options @returns {DownloadTask | null} */
function buildTask(kind, label, repo, file, url, options) {
  const destination = resolveManagedHfFilePath(options, repo, file);
  return repo && file && destination
    ? { kind, label, repo, file, url, destination }
    : null;
}

/** @param {string} repo @param {string} file */
function hfUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

module.exports = { collectRequiredHfDownloads };
