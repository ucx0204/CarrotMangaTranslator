// @ts-check
const { existsSync } = require("node:fs");
const path = require("node:path");

const GEMMA_12B_MMPROJ_REPO = "ggml-org/gemma-4-12B-it-GGUF";
const GEMMA_12B_MMPROJ_FILE = "mmproj-gemma-4-12B-it-BF16.gguf";
const LEGACY_GEMMA_12B_MMPROJ_FILE = "mmproj-gemma-4-12B-it-bf16.gguf";

const { isUsableFile } = require("../simple-page-download-utils.cjs");
const {
  findNamedFile,
  listSnapshotDirs,
} = require("../simple-page-file-search.cjs");
const {
  repoCacheDir,
  resolveHubCacheDir,
  resolveLegacyManagedHfFilePath,
  resolveLlamaCppCacheDir,
  resolveManagedHfFilePath,
} = require("../simple-page-cache-paths.cjs");
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredDraftModelUrl,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  shouldUseConfiguredMmproj,
} = require("../simple-page-model-config.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */

/** @param {ModelAssetOptions} [options] */
function resolveConfiguredMmprojUrl(options = {}) {
  if (!shouldUseConfiguredMmproj(options)) return null;
  const repo = resolveConfiguredMmprojRepo(options);
  const file = resolveConfiguredMmprojFile(options);
  return repo && file
    ? `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`
    : null;
}

/** @param {ModelAssetOptions} options @param {string} repo @param {string} file */
function resolveUsableManagedHfFile(options, repo, file) {
  return usableFileOrNull(resolveManagedHfFilePath(options, repo, file));
}

/** @param {string | null | undefined} filePath */
function usableFileOrNull(filePath) {
  return filePath && isUsableFile(filePath) ? filePath : null;
}

/** @param {ModelAssetOptions} options @param {string} repo @param {string} file */
function resolveUsableLegacyManagedHfFile(options, repo, file) {
  return usableFileOrNull(resolveLegacyManagedHfFilePath(options, repo, file));
}

/** @param {ModelAssetOptions} [options] */
function resolveCachedConfiguredMmprojPath(options = {}) {
  if (!shouldUseConfiguredMmproj(options)) return null;
  const repo = resolveConfiguredMmprojRepo(options);
  const file = resolveConfiguredMmprojFile(options);
  const current = resolveCachedHfAsset(options, repo, file, true);
  if (current) return current;
  // The lowercase projector was shipped previously and is known to work. It
  // remains a cache-only alias; all cold downloads use the canonical BF16 URL.
  return repo === GEMMA_12B_MMPROJ_REPO && file === GEMMA_12B_MMPROJ_FILE
    ? resolveCachedHfAsset(options, repo, LEGACY_GEMMA_12B_MMPROJ_FILE, true)
    : null;
}

/** @param {ModelAssetOptions} options @param {string} repo @param {string} file @param {boolean} includeLlamaCache */
function resolveCachedHfAsset(options, repo, file, includeLlamaCache) {
  return (
    resolveUsableManagedHfFile(options, repo, file) ||
    resolveUsableLegacyManagedHfFile(options, repo, file) ||
    findCachedHubAsset(options, repo, file) ||
    (includeLlamaCache ? resolveCachedLlamaCppFile(file, options) : null)
  );
}

/** @param {ModelAssetOptions} options @param {string} repo @param {string} file */
function findCachedHubAsset(options, repo, file) {
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir) return null;
  const repoDir = repoCacheDir(repo, hubCacheDir);
  if (!existsSync(repoDir)) return null;
  const snapshotMatch = listSnapshotDirs(repoDir)
    .map((snapshotDir) => path.join(snapshotDir, file))
    .find((candidate) => isUsableFile(candidate));
  return snapshotMatch || usableFileOrNull(findNamedFile(repoDir, file));
}

/** @param {string} fileName @param {ModelAssetOptions} [options] */
function resolveCachedLlamaCppFile(fileName, options = {}) {
  const cacheDir = resolveLlamaCppCacheDir(options);
  if (!cacheDir || !fileName || !existsSync(cacheDir)) return null;
  return (
    usableFileOrNull(path.join(cacheDir, fileName)) ||
    usableFileOrNull(findNamedFile(cacheDir, fileName, 2))
  );
}

/** @param {ModelAssetOptions} [options] */
function resolveCachedConfiguredDraftModelPath(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (!repo || !file) return null;
  return resolveCachedHfAsset(options, repo, file, false);
}

/** @param {ModelAssetOptions} [options] */
function resolveDraftAsset(options = {}) {
  const path = resolveCachedConfiguredDraftModelPath(options);
  return {
    draftModelPath: path,
    draftModelUrl: path ? null : resolveConfiguredDraftModelUrl(options),
  };
}

module.exports = {
  resolveCachedConfiguredDraftModelPath,
  resolveCachedConfiguredMmprojPath,
  resolveCachedLlamaCppFile,
  resolveConfiguredMmprojUrl,
  resolveDraftAsset,
  resolveUsableLegacyManagedHfFile,
  resolveUsableManagedHfFile,
  usableFileOrNull,
};
