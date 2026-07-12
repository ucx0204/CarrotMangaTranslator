// @ts-check
const { existsSync } = require("node:fs");
const { link, mkdir, rename, rm } = require("node:fs/promises");
const path = require("node:path");

const { isUsableFile } = require("../simple-page-download-utils.cjs");
const {
  resolveLegacyManagedHfFilePath,
  resolveManagedHfFilePath,
} = require("../simple-page-cache-paths.cjs");
const {
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  shouldUseConfiguredMmproj,
} = require("../simple-page-model-config.cjs");
const { createDetailedError } = require("../simple-page-runtime-common.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions */
/** @typedef {{ launchMode: string; modelPath?: string | null; mmprojPath?: string | null; draftModelPath?: string | null }} ModelLaunchTarget */
/** @typedef {{ allowLongAlias?: boolean; file: string; label: string; repo: string; sourcePath?: string | null }} CacheAsset */
const WINDOWS_LEGACY_MAX_PATH = 260;

/** @param {string} left @param {string} right */
function pathsEqual(left, right) {
  /** @param {string} value */
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/** @param {string} filePath */
function isWindowsLegacyLongPath(filePath) {
  return (
    process.platform === "win32" &&
    path.resolve(filePath).length >= WINDOWS_LEGACY_MAX_PATH
  );
}

/** @param {ModelAssetOptions} options @param {CacheAsset} asset */
async function ensureCompactCachedHfAsset(options, asset) {
  const migration = resolveCacheMigration(options, asset);
  if (!migration) return;
  const { sourcePath, destinationPath, canMove } = migration;
  assertCompactDestination(asset, sourcePath, destinationPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (isUsableFile(destinationPath)) return;
  if (existsSync(destinationPath)) await rm(destinationPath, { force: true });
  const renameResult = canMove
    ? await tryCacheOperation(
        () => rename(sourcePath, destinationPath),
        destinationPath,
      )
    : { complete: false, error: undefined };
  if (renameResult.complete) return;
  const linkResult = isUsableFile(sourcePath)
    ? await tryCacheOperation(
        () => link(sourcePath, destinationPath),
        destinationPath,
      )
    : { complete: false, error: undefined };
  if (linkResult.complete) return;
  throw buildMigrationError(
    asset,
    sourcePath,
    destinationPath,
    linkResult.error || renameResult.error,
  );
}

/** @param {ModelAssetOptions} options @param {CacheAsset} asset */
function resolveCacheMigration(options, asset) {
  const sourcePath = asset.sourcePath;
  if (!sourcePath || !isUsableFile(sourcePath)) return null;
  const destinationPath = resolveManagedHfFilePath(
    options,
    asset.repo,
    asset.file,
  );
  if (!destinationPath) return null;
  if (pathsEqual(sourcePath, destinationPath)) {
    assertAlreadyCompactPath(asset, destinationPath);
    return null;
  }
  const legacyPath = resolveLegacyManagedHfFilePath(
    options,
    asset.repo,
    asset.file,
  );
  const canMove = Boolean(legacyPath && pathsEqual(sourcePath, legacyPath));
  const needsAlias = Boolean(
    asset.allowLongAlias && isWindowsLegacyLongPath(sourcePath),
  );
  return canMove || needsAlias
    ? { sourcePath, destinationPath, canMove }
    : null;
}

/** @param {CacheAsset} asset @param {string} destinationPath */
function assertAlreadyCompactPath(asset, destinationPath) {
  if (!isWindowsLegacyLongPath(destinationPath)) return;
  throw createDetailedError(
    "Gemma 모델 캐시 루트가 너무 길어 Windows에서 모델을 실행할 수 없습니다.",
    {
      assetLabel: asset.label,
      destinationPath,
      destinationPathLength: path.resolve(destinationPath).length,
    },
  );
}

/** @param {CacheAsset} asset @param {string} sourcePath @param {string} destinationPath */
function assertCompactDestination(asset, sourcePath, destinationPath) {
  if (!isWindowsLegacyLongPath(destinationPath)) return;
  throw createDetailedError(
    "Gemma 모델 캐시 루트가 너무 길어 Windows에서 모델을 실행할 수 없습니다.",
    {
      assetLabel: asset.label,
      sourcePath,
      sourcePathLength: path.resolve(sourcePath).length,
      destinationPath,
      destinationPathLength: path.resolve(destinationPath).length,
    },
  );
}

/** @param {() => Promise<unknown>} operation @param {string} destinationPath */
async function tryCacheOperation(operation, destinationPath) {
  try {
    await operation();
    return { complete: isUsableFile(destinationPath), error: undefined };
  } catch (error) {
    return { complete: isUsableFile(destinationPath), error };
  }
}

/** @param {CacheAsset} asset @param {string} sourcePath @param {string} destinationPath @param {unknown} cause */
function buildMigrationError(asset, sourcePath, destinationPath, cause) {
  return createDetailedError(
    "기존 Gemma 모델을 짧은 캐시 경로로 옮기지 못했습니다.",
    {
      assetLabel: asset.label,
      sourcePath,
      sourcePathLength: path.resolve(sourcePath).length,
      destinationPath,
      destinationPathLength: path.resolve(destinationPath).length,
    },
    cause,
  );
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target */
async function ensureCompactCachedHfAssets(options, target) {
  if (["openai-codex", "openai-api"].includes(target.launchMode)) return;
  for (const asset of buildCacheAssets(options, target)) {
    await ensureCompactCachedHfAsset(options, asset);
  }
}

/** @param {ModelAssetOptions} options @param {ModelLaunchTarget} target @returns {CacheAsset[]} */
function buildCacheAssets(options, target) {
  const assets = [];
  if (target.launchMode !== "local") {
    assets.push({
      allowLongAlias: true,
      label: "Gemma 모델",
      repo: resolveConfiguredModelRepo(options),
      file: resolveConfiguredModelFile(options),
      sourcePath: target.modelPath,
    });
    if (shouldUseConfiguredMmproj(options)) {
      assets.push({
        allowLongAlias: true,
        label: "Gemma vision mmproj",
        repo: resolveConfiguredMmprojRepo(options),
        file: resolveConfiguredMmprojFile(options),
        sourcePath: target.mmprojPath,
      });
    }
  }
  if (options.useDraft) {
    assets.push({
      allowLongAlias: true,
      label: "Gemma draft 모델",
      repo: resolveConfiguredDraftModelRepo(options),
      file: resolveConfiguredDraftModelFile(options),
      sourcePath: target.draftModelPath,
    });
  }
  return assets;
}

/** @param {ModelLaunchTarget} target */
function assertWindowsModelLaunchPaths(target) {
  if (process.platform !== "win32") return;
  const unsafe = [
    ["Gemma 모델", target.modelPath],
    ["Gemma vision mmproj", target.mmprojPath],
    ["Gemma draft 모델", target.draftModelPath],
  ].find(
    ([, filePath]) =>
      typeof filePath === "string" && isWindowsLegacyLongPath(filePath),
  );
  if (!unsafe || typeof unsafe[1] !== "string") return;
  throw createDetailedError(
    "Gemma 모델 경로가 너무 길어 Windows에서 실행할 수 없습니다. 더 짧은 데이터 저장 위치를 사용해 주세요.",
    {
      assetLabel: unsafe[0],
      modelPath: unsafe[1],
      modelPathLength: path.resolve(unsafe[1]).length,
    },
  );
}

module.exports = {
  assertWindowsModelLaunchPaths,
  ensureCompactCachedHfAssets,
  isWindowsLegacyLongPath,
};
