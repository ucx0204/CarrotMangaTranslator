// @ts-check
const { existsSync } = require("node:fs");
const path = require("node:path");

const { isUsableFile } = require("../simple-page-download-utils.cjs");
const {
  findNamedFile,
  findPreferredMmprojFile,
  listSnapshotDirs,
} = require("../simple-page-file-search.cjs");
const {
  repoCacheDir,
  resolveHubCacheDir,
} = require("../simple-page-cache-paths.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredApiBaseUrl,
  resolveConfiguredApiModel,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredDraftModelUrl,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
} = require("../simple-page-model-config.cjs");
const {
  resolveCachedConfiguredMmprojPath,
  resolveCachedConfiguredDraftModelPath,
  resolveConfiguredMmprojUrl,
  resolveDraftAsset,
  resolveUsableLegacyManagedHfFile,
  resolveUsableManagedHfFile,
  usableFileOrNull,
} = require("./hf-cache-assets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */
/** @typedef {{ baseUrl?: string; draftModelPath?: string | null; draftModelUrl?: string | null; hubCacheDir?: string | null; launchMode: string; mmprojPath?: string | null; mmprojUrl?: string | null; model?: string; modelPath?: string | null; reasoningEffort?: string; repoDir?: string | null; requiresDownload: boolean; snapshotDir?: string | null }} ModelLaunchTarget */

/** @param {ModelAssetOptions} [options] @returns {ModelLaunchTarget} */
function resolveCachedModelAssets(options = {}) {
  const context = buildCacheContext(options);
  if (!context.hubCacheDir) return buildMissingModelTarget(context, null);
  const managedPath =
    context.managedModelPath || context.legacyManagedModelPath;
  if (managedPath) {
    return buildCachedTarget(
      context,
      managedPath,
      path.dirname(managedPath),
      false,
    );
  }
  if (!context.repoDir || !existsSync(context.repoDir)) {
    return buildMissingModelTarget(context, context.repoDir);
  }
  const snapshotTarget = findSnapshotModelTarget(context);
  if (snapshotTarget) return snapshotTarget;
  const namedPath = usableFileOrNull(
    findNamedFile(context.repoDir, context.modelFile),
  );
  return namedPath
    ? buildCachedTarget(context, namedPath, path.dirname(namedPath))
    : buildMissingModelTarget(context, context.repoDir);
}

/** @param {ModelAssetOptions} options */
function buildCacheContext(options) {
  const hubCacheDir = resolveHubCacheDir(options);
  const modelRepo = resolveConfiguredModelRepo(options);
  const modelFile = resolveConfiguredModelFile(options);
  const mmprojPath = resolveCachedConfiguredMmprojPath(options);
  const mmprojUrl = mmprojPath ? null : resolveConfiguredMmprojUrl(options);
  const draft = resolveDraftAsset(options);
  return {
    options,
    hubCacheDir,
    repoDir: hubCacheDir ? repoCacheDir(modelRepo, hubCacheDir) : null,
    modelFile,
    mmprojPath,
    mmprojUrl,
    ...draft,
    managedModelPath: resolveUsableManagedHfFile(options, modelRepo, modelFile),
    legacyManagedModelPath: resolveUsableLegacyManagedHfFile(
      options,
      modelRepo,
      modelFile,
    ),
  };
}

/** @param {ReturnType<typeof buildCacheContext>} context */
function requiresDraftDownload(context) {
  return Boolean(
    context.options.useDraft &&
    !context.draftModelPath &&
    context.draftModelUrl,
  );
}

/** @param {ReturnType<typeof buildCacheContext>} context @param {string | null} repoDir @returns {ModelLaunchTarget} */
function buildMissingModelTarget(context, repoDir) {
  return {
    hubCacheDir: context.hubCacheDir,
    repoDir,
    snapshotDir: null,
    modelPath: null,
    mmprojPath: context.mmprojPath,
    mmprojUrl: context.mmprojUrl,
    draftModelPath: context.draftModelPath,
    draftModelUrl: context.draftModelUrl,
    launchMode: "huggingface",
    requiresDownload: true,
  };
}

/** @param {ReturnType<typeof buildCacheContext>} context @param {string} modelPath @param {string} snapshotDir @returns {ModelLaunchTarget} */
function buildCachedTarget(
  context,
  modelPath,
  snapshotDir,
  detectSnapshotMmproj = true,
) {
  const detectedMmproj =
    context.mmprojPath ||
    (detectSnapshotMmproj
      ? usableFileOrNull(findPreferredMmprojFile(snapshotDir))
      : null);
  return {
    hubCacheDir: context.hubCacheDir,
    repoDir: context.repoDir,
    snapshotDir,
    modelPath,
    mmprojPath: detectedMmproj,
    mmprojUrl: detectedMmproj ? null : context.mmprojUrl,
    draftModelPath: context.draftModelPath,
    draftModelUrl: context.draftModelUrl,
    launchMode: "cached-hf",
    requiresDownload:
      (!detectedMmproj && Boolean(context.mmprojUrl)) ||
      requiresDraftDownload(context),
  };
}

/** @param {ReturnType<typeof buildCacheContext>} context */
function findSnapshotModelTarget(context) {
  const repoDir = context.repoDir;
  if (!repoDir) return null;
  for (const snapshotDir of listSnapshotDirs(repoDir)) {
    const modelPath = path.join(snapshotDir, context.modelFile);
    if (!isUsableFile(modelPath)) continue;
    const target = buildCachedTarget(context, modelPath, snapshotDir);
    if (target.mmprojPath || target.mmprojUrl) return target;
  }
  return null;
}

/** @param {ModelAssetOptions} [options] @returns {ModelLaunchTarget} */
function inspectModelLaunch(options = {}) {
  if (isOpenAICodexProvider(options)) return buildCodexTarget(options);
  if (isOpenAIApiProvider(options)) return buildApiTarget(options);
  if (resolveConfiguredModelSource(options) === "local")
    return buildLocalTarget(options);
  const cached = resolveCachedModelAssets(options);
  return {
    ...cached,
    requiresDownload: Boolean(
      cached.requiresDownload ?? cached.launchMode !== "cached-hf",
    ),
  };
}

/** @param {ModelAssetOptions} options @returns {ModelLaunchTarget} */
function buildCodexTarget(options) {
  return {
    launchMode: "openai-codex",
    model: resolveConfiguredCodexModel(options),
    reasoningEffort: resolveConfiguredCodexReasoningEffort(options),
    requiresDownload: false,
  };
}

/** @param {ModelAssetOptions} options @returns {ModelLaunchTarget} */
function buildApiTarget(options) {
  return {
    launchMode: "openai-api",
    baseUrl: resolveConfiguredApiBaseUrl(options),
    model: resolveConfiguredApiModel(options),
    requiresDownload: false,
  };
}

/** @param {ModelAssetOptions} options @returns {ModelLaunchTarget} */
function buildLocalTarget(options) {
  const modelPath = resolveConfiguredLocalModelPath(options);
  const explicitMmproj = resolveConfiguredLocalMmprojPath(options);
  const detectedMmproj = modelPath
    ? usableFileOrNull(findPreferredMmprojFile(path.dirname(modelPath)))
    : null;
  const draft = options.useDraft
    ? {
        draftModelPath: resolveCachedConfiguredDraftModelPath(options),
        draftModelUrl: resolveConfiguredDraftModelUrl(options),
      }
    : { draftModelPath: null, draftModelUrl: null };
  return {
    launchMode: "local",
    modelPath,
    mmprojPath: explicitMmproj || detectedMmproj,
    ...draft,
    requiresDownload: Boolean(
      options.useDraft && !draft.draftModelPath && draft.draftModelUrl,
    ),
  };
}

/** @param {ModelAssetOptions} [options] */
function isModelCached(options = {}) {
  const target = inspectModelLaunch(options);
  if (["openai-codex", "openai-api"].includes(target.launchMode)) return true;
  if (target.launchMode === "local") {
    return Boolean(
      target.modelPath &&
      isUsableFile(target.modelPath) &&
      (!options.useDraft || target.draftModelPath),
    );
  }
  return target.launchMode === "cached-hf" && !target.requiresDownload;
}

module.exports = {
  inspectModelLaunch,
  isModelCached,
  resolveCachedModelAssets,
};
