// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {RuntimeOptions & { useDraft?: boolean | null }} ModelAssetOptions
 * @typedef {{ kind: string; label: string; repo?: string; file: string; url: string; destination: string; progressPhase?: string; progressTitle?: string; completeTitle?: string }} DownloadTask
 * @typedef {{ archive: string; url: string }} LlamaRuntimeArchive
 * @typedef {{ archive?: string; archives?: LlamaRuntimeArchive[]; backend?: string; dir: string; id?: string; kind?: string; requiredFiles?: Array<string | string[]>; url?: string }} LlamaRuntimeDescriptor
 * @typedef {{ archive?: unknown; url?: unknown }} MarkerArchive
 */
/**
 * @typedef {{
 *   baseUrl?: string;
 *   draftModelPath?: string | null;
 *   draftModelUrl?: string | null;
 *   hubCacheDir?: string | null;
 *   launchMode: string;
 *   mmprojPath?: string | null;
 *   mmprojUrl?: string | null;
 *   model?: string;
 *   modelPath?: string | null;
 *   reasoningEffort?: string;
 *   repoDir?: string | null;
 *   requiresDownload: boolean;
 *   snapshotDir?: string | null;
 * }} ModelLaunchTarget
 */
const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
} = require("node:fs");
const { link, mkdir, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { bundledServerCandidates } = require("./resolve-llama-runtime.cjs");
const {
  LLAMA_RUNTIME_MARKER_FILE,
  shouldExtractLlamaRuntimeFile,
} = require("./simple-page-llama-runtimes.cjs");
const { PADDLE_OCR_MODEL_DOWNLOADS } = require("./simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const {
  downloadHfFileWithProgress,
  getFileSize,
  isUsableFile,
  probeContentLength,
} = require("./simple-page-download-utils.cjs");
const {
  findNamedFile,
  findPreferredMmprojFile,
  listSnapshotDirs,
} = require("./simple-page-file-search.cjs");
const {
  repoCacheDir,
  resolveHubCacheDir,
  resolveLegacyManagedHfFilePath,
  resolveLlamaCppCacheDir,
  resolveManagedHfFilePath,
} = require("./simple-page-cache-paths.cjs");
const {
  isOpenAIApiProvider,
  isOpenAICodexProvider,
  resolveConfiguredApiBaseUrl,
  resolveConfiguredApiModel,
  resolveConfiguredCodexModel,
  resolveConfiguredCodexReasoningEffort,
  resolveConfiguredDraftModelFile,
  resolveConfiguredDraftModelRepo,
  resolveConfiguredDraftModelUrl,
  resolveConfiguredLocalMmprojPath,
  resolveConfiguredLocalModelPath,
  resolveConfiguredModelFile,
  resolveConfiguredModelRepo,
  resolveConfiguredModelSource,
  resolveConfiguredMmprojFile,
  resolveConfiguredMmprojRepo,
  shouldUseConfiguredMmproj,
} = require("./simple-page-model-config.cjs");
const {
  hasRequiredLlamaRuntimeFiles,
  missingRequiredLlamaRuntimeFiles,
  resolveLlamaRuntimeSearchDirs,
  resolveManagedToolsDir,
  resolvePreferredLlamaRuntime,
  resolveToolsDir,
} = require("./simple-page-runtime-paths.cjs");
const { extractSelectedZipEntries } = require("./simple-page-zip-utils.cjs");
const {
  collectRequiredPaddleOcrModelDownloads,
  resolvePaddleOcrModelCacheDir,
} = require("./simple-page-ocr-model-assets.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("./simple-page-runtime-common.cjs");

/** @param {ModelAssetOptions} [options] */
function resolveConfiguredMmprojUrl(options = {}) {
  if (!shouldUseConfiguredMmproj(options)) {
    return null;
  }
  const repo = resolveConfiguredMmprojRepo(options);
  const file = resolveConfiguredMmprojFile(options);
  if (!repo || !file) {
    return null;
  }
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

/**
 * @param {ModelAssetOptions} options
 * @param {string} repo
 * @param {string} file
 * @returns {string | null}
 */
function resolveUsableManagedHfFile(options, repo, file) {
  const managedPath = resolveManagedHfFilePath(options, repo, file);
  return usableFileOrNull(managedPath);
}

/** @param {string | null | undefined} filePath */
function usableFileOrNull(filePath) {
  return filePath && isUsableFile(filePath) ? filePath : null;
}

/**
 * @param {ModelAssetOptions} options
 * @param {string} repo
 * @param {string} file
 * @returns {string | null}
 */
function resolveUsableLegacyManagedHfFile(options, repo, file) {
  const legacyPath = resolveLegacyManagedHfFilePath(options, repo, file);
  return usableFileOrNull(legacyPath);
}

/** @param {ModelAssetOptions} [options] */
function resolveCachedConfiguredMmprojPath(options = {}) {
  if (!shouldUseConfiguredMmproj(options)) {
    return null;
  }
  const configuredRepo = resolveConfiguredMmprojRepo(options);
  const configuredFile = resolveConfiguredMmprojFile(options);
  const managedPath = resolveUsableManagedHfFile(
    options,
    configuredRepo,
    configuredFile,
  );
  if (managedPath) {
    return managedPath;
  }
  const legacyManagedPath = resolveUsableLegacyManagedHfFile(
    options,
    configuredRepo,
    configuredFile,
  );
  if (legacyManagedPath) {
    return legacyManagedPath;
  }
  const hubCacheDir = resolveHubCacheDir(options);
  if (hubCacheDir) {
    const repoDir = repoCacheDir(configuredRepo, hubCacheDir);
    if (existsSync(repoDir)) {
      for (const snapshotDir of listSnapshotDirs(repoDir)) {
        const mmprojPath = path.join(snapshotDir, configuredFile);
        if (isUsableFile(mmprojPath)) {
          return mmprojPath;
        }
      }
      const namedMatch = findNamedFile(repoDir, configuredFile);
      if (namedMatch && isUsableFile(namedMatch)) {
        return namedMatch;
      }
    }
  }
  return resolveCachedLlamaCppFile(configuredFile, options);
}

/**
 * @param {string} fileName
 * @param {ModelAssetOptions} [options]
 */
function resolveCachedLlamaCppFile(fileName, options = {}) {
  const cacheDir = resolveLlamaCppCacheDir(options);
  if (!cacheDir || !fileName || !existsSync(cacheDir)) {
    return null;
  }
  const directPath = path.join(cacheDir, fileName);
  if (isUsableFile(directPath)) {
    return directPath;
  }
  return usableFileOrNull(findNamedFile(cacheDir, fileName, 2));
}

/**
 * @param {ModelAssetOptions} [options]
 * @param {ModelLaunchTarget} [launchTarget]
 * @returns {DownloadTask[]}
 */
function collectRequiredHfDownloads(
  options = {},
  launchTarget = inspectModelLaunch(options),
) {
  if (launchTarget.launchMode === "openai-codex") {
    return [];
  }
  if (launchTarget.launchMode === "openai-api") {
    return [];
  }

  /** @type {DownloadTask[]} */
  const tasks = [];
  if (launchTarget.launchMode !== "local" && !launchTarget.modelPath) {
    const repo = resolveConfiguredModelRepo(options);
    const file = resolveConfiguredModelFile(options);
    const url = `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
    const destination = resolveManagedHfFilePath(options, repo, file);
    if (repo && file && destination) {
      tasks.push({
        kind: "model",
        label: "Gemma 모델",
        repo,
        file,
        url,
        destination,
      });
    }
  }

  if (launchTarget.mmprojUrl && !launchTarget.mmprojPath) {
    const repo = resolveConfiguredMmprojRepo(options);
    const file = resolveConfiguredMmprojFile(options);
    const destination = resolveManagedHfFilePath(options, repo, file);
    if (repo && file && destination) {
      tasks.push({
        kind: "mmproj",
        label: "Gemma vision mmproj",
        repo,
        file,
        url: launchTarget.mmprojUrl,
        destination,
      });
    }
  }

  if (
    options.useDraft &&
    launchTarget.draftModelUrl &&
    !launchTarget.draftModelPath
  ) {
    const repo = resolveConfiguredDraftModelRepo(options);
    const file = resolveConfiguredDraftModelFile(options);
    const destination = resolveManagedHfFilePath(options, repo, file);
    if (repo && file && destination) {
      tasks.push({
        kind: "draft",
        label: "Gemma draft 모델",
        repo,
        file,
        url: launchTarget.draftModelUrl,
        destination,
      });
    }
  }

  return tasks;
}

const WINDOWS_LEGACY_MAX_PATH = 260;

/**
 * @param {string} left
 * @param {string} right
 */
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

/**
 * Move app-managed v0.10.1 files to the compact cache layout. If an in-place
 * rename is unavailable, create a hard link so the multi-gigabyte model is
 * not copied or downloaded again.
 *
 * @param {ModelAssetOptions} options
 * @param {{ allowLongAlias?: boolean; file: string; label: string; repo: string; sourcePath?: string | null }} asset
 */
async function ensureCompactCachedHfAsset(options, asset) {
  const sourcePath = asset.sourcePath;
  if (!sourcePath || !isUsableFile(sourcePath)) {
    return;
  }
  const destinationPath = resolveManagedHfFilePath(
    options,
    asset.repo,
    asset.file,
  );
  if (!destinationPath) {
    return;
  }
  if (pathsEqual(sourcePath, destinationPath)) {
    if (isWindowsLegacyLongPath(destinationPath)) {
      throw createDetailedError(
        "Gemma 모델 캐시 루트가 너무 길어 Windows에서 모델을 실행할 수 없습니다.",
        {
          assetLabel: asset.label,
          destinationPath,
          destinationPathLength: path.resolve(destinationPath).length,
        },
      );
    }
    return;
  }

  const legacyPath = resolveLegacyManagedHfFilePath(
    options,
    asset.repo,
    asset.file,
  );
  const canMove = Boolean(legacyPath && pathsEqual(sourcePath, legacyPath));
  const needsLongAlias = Boolean(
    asset.allowLongAlias && isWindowsLegacyLongPath(sourcePath),
  );
  if (!canMove && !needsLongAlias) {
    return;
  }
  if (isWindowsLegacyLongPath(destinationPath)) {
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

  await mkdir(path.dirname(destinationPath), { recursive: true });
  if (isUsableFile(destinationPath)) {
    return;
  }
  if (existsSync(destinationPath)) {
    await rm(destinationPath, { force: true });
  }

  /** @type {unknown} */
  let lastError;
  if (canMove) {
    try {
      await rename(sourcePath, destinationPath);
      if (isUsableFile(destinationPath)) {
        return;
      }
    } catch (error) {
      lastError = error;
      if (isUsableFile(destinationPath)) {
        return;
      }
    }
  }

  if (isUsableFile(sourcePath)) {
    try {
      await link(sourcePath, destinationPath);
      if (isUsableFile(destinationPath)) {
        return;
      }
    } catch (error) {
      lastError = error;
      if (isUsableFile(destinationPath)) {
        return;
      }
    }
  }

  throw createDetailedError(
    "기존 Gemma 모델을 짧은 캐시 경로로 옮기지 못했습니다.",
    {
      assetLabel: asset.label,
      sourcePath,
      sourcePathLength: path.resolve(sourcePath).length,
      destinationPath,
      destinationPathLength: path.resolve(destinationPath).length,
    },
    lastError,
  );
}

/**
 * @param {ModelAssetOptions} options
 * @param {ModelLaunchTarget} launchTarget
 */
async function ensureCompactCachedHfAssets(options, launchTarget) {
  if (
    launchTarget.launchMode === "openai-codex" ||
    launchTarget.launchMode === "openai-api"
  ) {
    return;
  }

  const assets = [
    ...(launchTarget.launchMode !== "local"
      ? [
          {
            allowLongAlias: true,
            label: "Gemma 모델",
            repo: resolveConfiguredModelRepo(options),
            file: resolveConfiguredModelFile(options),
            sourcePath: launchTarget.modelPath,
          },
          ...(shouldUseConfiguredMmproj(options)
            ? [
                {
                  allowLongAlias: true,
                  label: "Gemma vision mmproj",
                  repo: resolveConfiguredMmprojRepo(options),
                  file: resolveConfiguredMmprojFile(options),
                  sourcePath: launchTarget.mmprojPath,
                },
              ]
            : []),
        ]
      : []),
    ...(options.useDraft
      ? [
          {
            allowLongAlias: true,
            label: "Gemma draft 모델",
            repo: resolveConfiguredDraftModelRepo(options),
            file: resolveConfiguredDraftModelFile(options),
            sourcePath: launchTarget.draftModelPath,
          },
        ]
      : []),
  ];
  for (const asset of assets) {
    await ensureCompactCachedHfAsset(options, asset);
  }
}

/** @param {ModelLaunchTarget} launchTarget */
function assertWindowsModelLaunchPaths(launchTarget) {
  if (process.platform !== "win32") {
    return;
  }
  const candidates = [
    ["Gemma 모델", launchTarget.modelPath],
    ["Gemma vision mmproj", launchTarget.mmprojPath],
    ["Gemma draft 모델", launchTarget.draftModelPath],
  ];
  const unsafe = candidates.find(
    (candidate) =>
      typeof candidate[1] === "string" && isWindowsLegacyLongPath(candidate[1]),
  );
  if (!unsafe || typeof unsafe[1] !== "string") {
    return;
  }
  throw createDetailedError(
    "Gemma 모델 경로가 너무 길어 Windows에서 실행할 수 없습니다. 더 짧은 데이터 저장 위치를 사용해 주세요.",
    {
      assetLabel: unsafe[0],
      modelPath: unsafe[1],
      modelPathLength: path.resolve(unsafe[1]).length,
    },
  );
}

/**
 * @param {ModelAssetOptions} [options]
 * @param {ModelLaunchTarget} [launchTarget]
 */
async function ensureHfModelAssetsDownloaded(
  options = {},
  launchTarget = inspectModelLaunch(options),
) {
  await ensureCompactCachedHfAssets(options, launchTarget);
  const refreshedLaunchTarget = inspectModelLaunch(options);
  assertWindowsModelLaunchPaths(refreshedLaunchTarget);
  const tasks = collectRequiredHfDownloads(
    options,
    refreshedLaunchTarget,
  ).filter((task) => !isUsableFile(task.destination));
  const unsafeDestination = tasks.find((task) =>
    isWindowsLegacyLongPath(task.destination),
  );
  if (unsafeDestination) {
    throw createDetailedError(
      "Gemma 모델 캐시 루트가 너무 길어 Windows에서 모델을 실행할 수 없습니다.",
      {
        assetLabel: unsafeDestination.label,
        destinationPath: unsafeDestination.destination,
        destinationPathLength: path.resolve(unsafeDestination.destination)
          .length,
      },
    );
  }
  if (tasks.length === 0) {
    return;
  }

  let knownTotalBytes = 0;
  const totals = new Map();
  for (const task of tasks) {
    const totalBytes = await probeContentLength(task.url, options.abortSignal);
    if (Number.isFinite(totalBytes) && totalBytes > 0) {
      totals.set(task.destination, totalBytes);
      knownTotalBytes += totalBytes;
    }
  }

  const hasKnownAggregate = knownTotalBytes > 0 && totals.size === tasks.length;
  let completedBytes = 0;
  emitRuntimeProgress(
    options,
    "model_downloading",
    "Gemma 모델 다운로드 중",
    `${tasks.length}개 파일 준비`,
    {
      progressMode: hasKnownAggregate ? "determinate" : "log-only",
      progressPercent: hasKnownAggregate ? 0 : undefined,
      progressBytes: 0,
      progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
      installLogLine: `다운로드 대상 ${tasks.length}개 파일을 확인했습니다.`,
    },
  );

  for (const task of tasks) {
    const totalBytes = totals.get(task.destination) || 0;
    await downloadHfFileWithProgress(task, options, {
      totalBytes,
      knownAggregateBytes: hasKnownAggregate ? knownTotalBytes : 0,
      completedBytes,
      /** @param {number} bytesWritten */
      onComplete: (bytesWritten) => {
        completedBytes += hasKnownAggregate ? totalBytes : bytesWritten;
      },
    });
  }

  assertWindowsModelLaunchPaths(inspectModelLaunch(options));

  emitRuntimeProgress(
    options,
    "model_downloading",
    "Gemma 모델 다운로드 완료",
    "모든 모델 파일을 로컬 캐시에 저장했습니다.",
    {
      progressMode: hasKnownAggregate ? "determinate" : "log-only",
      progressPercent: hasKnownAggregate ? 1 : undefined,
      progressBytes: hasKnownAggregate ? knownTotalBytes : undefined,
      progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
      installLogLine: "Gemma 모델 파일 다운로드가 완료되었습니다.",
    },
  );
}

/** @param {ModelAssetOptions} [options] */
async function ensureDefaultLlamaRuntimeDownloaded(options = {}) {
  const runtime = resolvePreferredLlamaRuntime(options);
  const managedToolsDir = resolveManagedToolsDir(options);
  const runtimeDir = path.join(managedToolsDir, runtime.dir);
  const serverPath = path.join(
    runtimeDir,
    process.platform === "win32" ? "llama-server.exe" : "llama-server",
  );
  if (
    isCurrentLlamaRuntime(runtimeDir, runtime) &&
    hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)
  ) {
    return;
  }

  if (process.platform !== "win32") {
    throw createDetailedError("Bundled llama-server binary is missing.", {
      serverPath,
      toolsDir: resolveToolsDir(options),
      managedToolsDir,
      checkedServerPaths: resolveLlamaRuntimeSearchDirs(options).flatMap(
        (dir) => bundledServerCandidates(dir),
      ),
    });
  }

  const downloadsDir = path.join(managedToolsDir, ".downloads");
  const archives = getLlamaRuntimeArchives(runtime);
  /** @type {Map<string, number>} */
  const archiveTotals = new Map();
  let knownAggregateBytes = 0;
  for (const archive of archives) {
    const totalBytes = await probeContentLength(
      archive.url,
      options.abortSignal,
    );
    if (Number.isFinite(totalBytes) && totalBytes > 0) {
      archiveTotals.set(archive.archive, totalBytes);
      knownAggregateBytes += totalBytes;
    }
  }
  const hasKnownAggregate =
    knownAggregateBytes > 0 && archiveTotals.size === archives.length;
  let completedBytes = 0;
  /** @type {string[]} */
  const archivePaths = [];
  for (const archive of archives) {
    const archivePath = path.join(downloadsDir, archive.archive);
    archivePaths.push(archivePath);
    const totalBytes = archiveTotals.get(archive.archive) || 0;
    await downloadHfFileWithProgress(
      {
        kind: "llama-runtime",
        label: `Gemma 실행 런타임 (${runtime.kind})`,
        file: archive.archive,
        url: archive.url,
        destination: archivePath,
        progressPhase: "model_downloading",
        progressTitle: "Gemma 실행 런타임 다운로드 중",
        completeTitle: "Gemma 실행 런타임 다운로드 완료",
      },
      options,
      {
        totalBytes,
        knownAggregateBytes: hasKnownAggregate ? knownAggregateBytes : 0,
        completedBytes,
        /** @param {number} bytesWritten */
        onComplete: (bytesWritten) => {
          completedBytes += hasKnownAggregate ? totalBytes : bytesWritten;
        },
      },
    );
  }

  emitRuntimeProgress(
    options,
    "model_downloading",
    "Gemma 실행 런타임 설치 중",
    runtime.dir,
    {
      progressMode: "indeterminate",
      installLogLine: `Gemma 실행 파일과 ${formatLlamaRuntimeBackend(runtime)} 런타임 파일을 앱 데이터 폴더에 풀고 있습니다.`,
    },
  );
  await safeCleanup("remove stale llama runtime directory", () =>
    rm(runtimeDir, { recursive: true, force: true }),
  );
  await mkdir(runtimeDir, { recursive: true });
  for (const archivePath of archivePaths) {
    await extractSelectedZipEntries(
      archivePath,
      runtimeDir,
      shouldExtractLlamaRuntimeFile,
    );
  }

  const missingFiles = missingRequiredLlamaRuntimeFiles(runtimeDir, runtime);
  if (missingFiles.length > 0) {
    throw createDetailedError(
      "Gemma 실행 런타임을 설치했지만 필수 실행 파일 또는 GPU 런타임 파일을 찾지 못했습니다.",
      {
        archives: archivePaths,
        runtimeDir,
        serverPath,
        missingFiles,
      },
    );
  }
  await writeFile(
    path.join(runtimeDir, LLAMA_RUNTIME_MARKER_FILE),
    `${JSON.stringify(
      {
        id: runtime.id,
        kind: runtime.kind,
        dir: runtime.dir,
        archives,
        requiredFiles: runtime.requiredFiles,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  emitRuntimeProgress(
    options,
    "model_downloading",
    "Gemma 실행 런타임 설치 완료",
    runtime.dir,
    {
      progressMode: "determinate",
      progressPercent: 1,
      installLogLine: "Gemma 실행 런타임 준비가 완료되었습니다.",
    },
  );
}

/** @param {Partial<LlamaRuntimeDescriptor>} [runtime] */
function formatLlamaRuntimeBackend(runtime = {}) {
  const backend = String(runtime.backend || "cuda").toLowerCase();
  if (backend === "vulkan") {
    return "Vulkan";
  }
  if (backend === "rocm" || backend === "hip") {
    return "ROCm/HIP";
  }
  return "CUDA";
}

function isCurrentLlamaRuntime(
  /** @type {string} */
  runtimeDir,
  /** @type {LlamaRuntimeDescriptor} */
  runtime = resolvePreferredLlamaRuntime({}),
) {
  try {
    const marker =
      /** @type {{ id?: unknown; kind?: unknown; dir?: unknown; archives?: MarkerArchive[] }} */ (
        JSON.parse(
          readFileSync(
            path.join(runtimeDir, LLAMA_RUNTIME_MARKER_FILE),
            "utf8",
          ),
        )
      );
    const expectedArchives = getLlamaRuntimeArchives(runtime);
    const markerArchives = Array.isArray(marker?.archives)
      ? marker.archives
      : [];
    return (
      marker?.id === runtime.id &&
      marker?.kind === runtime.kind &&
      marker?.dir === runtime.dir &&
      expectedArchives.every((archive) =>
        markerArchives.some(
          (candidate) =>
            candidate?.archive === archive.archive &&
            candidate?.url === archive.url,
        ),
      )
    );
  } catch (_error) {
    return false;
  }
}

/**
 * @param {LlamaRuntimeDescriptor | null | undefined} runtime
 * @returns {LlamaRuntimeArchive[]}
 */
function getLlamaRuntimeArchives(runtime) {
  if (Array.isArray(runtime?.archives) && runtime.archives.length > 0) {
    return runtime.archives;
  }
  return runtime?.archive && runtime?.url
    ? [{ archive: runtime.archive, url: runtime.url }]
    : [];
}

/**
 * @param {ModelAssetOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @returns {Promise<void>}
 */
async function ensurePaddleOcrModelAssetsDownloaded(
  options = {},
  runtime = null,
) {
  if (
    isTruthy(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_SKIP_PADDLE_MODEL_PREFETCH",
        options,
      ) ?? "false",
    )
  ) {
    return;
  }

  const allTasks = collectRequiredPaddleOcrModelDownloads(options, runtime);
  /** @type {DownloadTask[]} */
  const pending = [];
  /** @type {Map<string, number>} */
  const totals = new Map();
  let knownTotalBytes = 0;

  for (const task of allTasks) {
    const totalBytes = await probeContentLength(task.url, options.abortSignal);
    const existingSize = getFileSize(task.destination);
    const assetProblem = inspectPaddleOcrAssetFile(task.destination, task.file);
    if (assetProblem) {
      await safeCleanup("remove corrupt Paddle OCR model asset", () =>
        rm(task.destination, { force: true }),
      );
      emitRuntimeProgress(
        options,
        "ocr_downloading",
        "Paddle OCR 모델 파일 재검사 중",
        `${task.label}: ${task.file}`,
        {
          progressMode: "log-only",
          installLogLine: `깨진 OCR 모델 파일을 다시 받습니다: ${task.file} (${assetProblem})`,
        },
      );
      pending.push(task);
      if (totalBytes > 0) {
        totals.set(task.destination, totalBytes);
        knownTotalBytes += totalBytes;
      }
      continue;
    }
    if (totalBytes > 0 && existingSize === totalBytes) {
      continue;
    }
    if (totalBytes <= 0 && existingSize > 0) {
      continue;
    }
    if (existingSize > 0 && totalBytes > 0 && existingSize !== totalBytes) {
      await safeCleanup("remove partial Paddle OCR model asset", () =>
        rm(task.destination, { force: true }),
      );
    }
    pending.push(task);
    if (totalBytes > 0) {
      totals.set(task.destination, totalBytes);
      knownTotalBytes += totalBytes;
    }
  }

  if (pending.length === 0) {
    return;
  }

  const hasKnownAggregate =
    knownTotalBytes > 0 && totals.size === pending.length;
  let completedBytes = 0;
  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 파일 다운로드 중",
    `${pending.length}개 파일 준비`,
    {
      progressMode: hasKnownAggregate ? "determinate" : "log-only",
      progressPercent: hasKnownAggregate ? 0 : undefined,
      progressBytes: 0,
      progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
      installLogLine: `Paddle OCR 모델 다운로드 대상 ${pending.length}개 파일을 확인했습니다.`,
    },
  );

  for (const task of pending) {
    const totalBytes = totals.get(task.destination) || 0;
    await downloadHfFileWithProgress(task, options, {
      totalBytes,
      knownAggregateBytes: hasKnownAggregate ? knownTotalBytes : 0,
      completedBytes,
      /** @param {number} bytesWritten */
      onComplete: (bytesWritten) => {
        completedBytes += hasKnownAggregate ? totalBytes : bytesWritten;
      },
    });
  }

  emitRuntimeProgress(
    options,
    "ocr_downloading",
    "Paddle OCR 모델 파일 다운로드 완료",
    "모든 Paddle OCR 모델 파일을 로컬 캐시에 저장했습니다.",
    {
      progressMode: hasKnownAggregate ? "determinate" : "log-only",
      progressPercent: hasKnownAggregate ? 1 : undefined,
      progressBytes: hasKnownAggregate ? knownTotalBytes : undefined,
      progressTotalBytes: hasKnownAggregate ? knownTotalBytes : undefined,
      installLogLine: "Paddle OCR 모델 파일 다운로드가 완료되었습니다.",
    },
  );
}

/**
 * @param {ModelAssetOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @param {unknown} [reason]
 */
async function repairPaddleOcrModelAssetsCache(
  options = {},
  runtime = null,
  reason = "",
) {
  const runtimeDir =
    runtime?.runtimeDir ||
    options.ocrRuntimeDir ||
    path.join(options.workingDir || process.cwd(), "ocr-runtime");
  const names = resolvePaddleOcrModelNamesForRepair(String(reason ?? ""));
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

  for (const modelName of names) {
    const modelDir = resolvePaddleOcrModelCacheDir(runtimeDir, modelName);
    if (!isSafePaddleOcrModelCacheDir(runtimeDir, modelDir)) {
      throw createDetailedError("Unsafe Paddle OCR model cache path.", {
        runtimeDir,
        modelDir,
        modelName,
      });
    }
    await safeCleanup("remove corrupt cached HF model directory", () =>
      rm(modelDir, { recursive: true, force: true }),
    );
  }

  await ensurePaddleOcrModelAssetsDownloaded(options, runtime);
}

/** @param {unknown} value */
function isPaddleOcrModelAssetLoadFailure(value) {
  const text = stringifyErrorForDetection(value);
  return /json\.exception\.parse_error\.101|attempting to parse an empty input|Creating model:\s*\('?(PP-DocLayoutV3|PaddleOCR-VL-1\.[56]|PP-OCRv[56]_(server|medium)_det|PP-OCRv[56]_(server|medium)_rec)/i.test(
    text,
  );
}

/** @param {unknown} [reason] */
function resolvePaddleOcrModelNamesForRepair(reason = "") {
  const text = stringifyErrorForDetection(reason);
  const explicit = PADDLE_OCR_MODEL_DOWNLOADS.map((model) => model.name).filter(
    (name) => text.includes(name),
  );
  return explicit.length > 0
    ? explicit
    : PADDLE_OCR_MODEL_DOWNLOADS.map((model) => model.name);
}

/**
 * @param {string} runtimeDir
 * @param {string} modelDir
 */
function isSafePaddleOcrModelCacheDir(runtimeDir, modelDir) {
  const root = path.resolve(runtimeDir, "paddlex-cache", "official_models");
  const resolved = path.resolve(modelDir);
  const relative = path.relative(root, resolved);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * @param {string} filePath
 * @param {string} [fileName]
 */
function inspectPaddleOcrAssetFile(filePath, fileName = "") {
  if (!existsSync(filePath)) {
    return null;
  }
  const size = getFileSize(filePath);
  if (size <= 0) {
    return "empty";
  }
  const lowerName = String(fileName || filePath).toLowerCase();
  const head = readFileHead(filePath, Math.min(size, 4096));
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1/m.test(head)) {
    return "git-lfs-pointer";
  }
  if (lowerName.endsWith(".json")) {
    try {
      JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      return `invalid-json: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/**
 * @param {string} filePath
 * @param {number} maxLength
 */
function readFileHead(filePath, maxLength) {
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.max(0, maxLength));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (_error) {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (_error) {
        // Ignore close errors for cache validation.
      }
    }
  }
}

/** @param {unknown} value */
function stringifyErrorForDetection(value) {
  if (!value || typeof value !== "object") {
    return String(value ?? "");
  }
  const record =
    /** @type {{ message?: unknown; stderrPreview?: unknown; stdoutPreview?: unknown; cause?: unknown }} */ (
      value
    );
  return [
    record.message,
    record.stderrPreview,
    record.stdoutPreview,
    record.cause,
  ]
    .filter(Boolean)
    .map((part) => String(part))
    .join(" ");
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 */
function truncateReason(value, maxLength = 500) {
  const text = stringifyErrorForDetection(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

/** @param {ModelAssetOptions} [options] */
function resolveCachedConfiguredDraftModelPath(options = {}) {
  const repo = resolveConfiguredDraftModelRepo(options);
  const file = resolveConfiguredDraftModelFile(options);
  if (!repo || !file) {
    return null;
  }
  const managedPath = resolveUsableManagedHfFile(options, repo, file);
  if (managedPath) {
    return managedPath;
  }
  const legacyManagedPath = resolveUsableLegacyManagedHfFile(
    options,
    repo,
    file,
  );
  if (legacyManagedPath) {
    return legacyManagedPath;
  }
  const hubCacheDir = resolveHubCacheDir(options);
  if (!hubCacheDir) {
    return null;
  }
  const repoDir = repoCacheDir(repo, hubCacheDir);
  if (!existsSync(repoDir)) {
    return null;
  }
  for (const snapshotDir of listSnapshotDirs(repoDir)) {
    const draftPath = path.join(snapshotDir, file);
    if (isUsableFile(draftPath)) {
      return draftPath;
    }
  }
  return usableFileOrNull(findNamedFile(repoDir, file));
}

/**
 * @returns {ModelLaunchTarget}
 */
/** @param {ModelAssetOptions} [options] */
function resolveCachedModelAssets(options = {}) {
  const hubCacheDir = resolveHubCacheDir(options);
  const configuredMmprojPath = resolveCachedConfiguredMmprojPath(options);
  const configuredMmprojUrl = configuredMmprojPath
    ? null
    : resolveConfiguredMmprojUrl(options);
  const draftModelPath = resolveCachedConfiguredDraftModelPath(options);
  const draftModelUrl = draftModelPath
    ? null
    : resolveConfiguredDraftModelUrl(options);
  const requiresDraftDownload = Boolean(
    options.useDraft && !draftModelPath && draftModelUrl,
  );
  if (!hubCacheDir) {
    return {
      hubCacheDir: null,
      repoDir: null,
      snapshotDir: null,
      modelPath: null,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "huggingface",
      requiresDownload: true,
    };
  }

  const configuredModelRepo = resolveConfiguredModelRepo(options);
  const configuredModelFile = resolveConfiguredModelFile(options);
  const repoDir = repoCacheDir(configuredModelRepo, hubCacheDir);
  const managedModelPath = resolveUsableManagedHfFile(
    options,
    configuredModelRepo,
    configuredModelFile,
  );
  const legacyManagedModelPath = resolveUsableLegacyManagedHfFile(
    options,
    configuredModelRepo,
    configuredModelFile,
  );
  const preferredManagedModelPath = managedModelPath || legacyManagedModelPath;
  if (preferredManagedModelPath) {
    return {
      hubCacheDir,
      repoDir,
      snapshotDir: path.dirname(preferredManagedModelPath),
      modelPath: preferredManagedModelPath,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojPath ? null : configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "cached-hf",
      requiresDownload:
        (!configuredMmprojPath && Boolean(configuredMmprojUrl)) ||
        requiresDraftDownload,
    };
  }
  if (!existsSync(repoDir)) {
    return {
      hubCacheDir,
      repoDir,
      snapshotDir: null,
      modelPath: null,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "huggingface",
      requiresDownload: true,
    };
  }

  for (const snapshotDir of listSnapshotDirs(repoDir)) {
    const modelPath = path.join(snapshotDir, configuredModelFile);
    if (!isUsableFile(modelPath)) {
      continue;
    }

    const mmprojPath =
      configuredMmprojPath ||
      usableFileOrNull(findPreferredMmprojFile(snapshotDir));
    if (mmprojPath) {
      return {
        hubCacheDir,
        repoDir,
        snapshotDir,
        modelPath,
        mmprojPath,
        mmprojUrl: null,
        draftModelPath,
        draftModelUrl,
        launchMode: "cached-hf",
        requiresDownload: requiresDraftDownload,
      };
    }

    if (configuredMmprojUrl) {
      return {
        hubCacheDir,
        repoDir,
        snapshotDir,
        modelPath,
        mmprojPath: null,
        mmprojUrl: configuredMmprojUrl,
        draftModelPath,
        draftModelUrl,
        launchMode: "cached-hf",
        requiresDownload: true,
      };
    }
  }

  const modelPath = usableFileOrNull(
    findNamedFile(repoDir, configuredModelFile),
  );
  if (!modelPath) {
    return {
      hubCacheDir,
      repoDir,
      snapshotDir: null,
      modelPath: null,
      mmprojPath: configuredMmprojPath,
      mmprojUrl: configuredMmprojUrl,
      draftModelPath,
      draftModelUrl,
      launchMode: "huggingface",
      requiresDownload: true,
    };
  }

  const snapshotDir = path.dirname(modelPath);
  const mmprojPath =
    configuredMmprojPath ||
    usableFileOrNull(findPreferredMmprojFile(snapshotDir));
  return {
    hubCacheDir,
    repoDir,
    snapshotDir,
    modelPath,
    mmprojPath,
    mmprojUrl: mmprojPath ? null : configuredMmprojUrl,
    draftModelPath,
    draftModelUrl,
    launchMode: "cached-hf",
    requiresDownload:
      (!mmprojPath && Boolean(configuredMmprojUrl)) || requiresDraftDownload,
  };
}

/**
 * @returns {ModelLaunchTarget}
 * @param {ModelAssetOptions} [options]
 */
function inspectModelLaunch(options = {}) {
  if (isOpenAICodexProvider(options)) {
    return {
      launchMode: "openai-codex",
      model: resolveConfiguredCodexModel(options),
      reasoningEffort: resolveConfiguredCodexReasoningEffort(options),
      requiresDownload: false,
    };
  }

  if (isOpenAIApiProvider(options)) {
    return {
      launchMode: "openai-api",
      baseUrl: resolveConfiguredApiBaseUrl(options),
      model: resolveConfiguredApiModel(options),
      requiresDownload: false,
    };
  }

  if (resolveConfiguredModelSource(options) === "local") {
    const modelPath = resolveConfiguredLocalModelPath(options);
    const explicitMmprojPath = resolveConfiguredLocalMmprojPath(options);
    const detectedMmprojPath = modelPath
      ? usableFileOrNull(findPreferredMmprojFile(path.dirname(modelPath)))
      : null;
    const mmprojPath = explicitMmprojPath || detectedMmprojPath;
    const draftModelPath = options.useDraft
      ? resolveCachedConfiguredDraftModelPath(options)
      : null;
    const draftModelUrl = options.useDraft
      ? resolveConfiguredDraftModelUrl(options)
      : null;

    return {
      launchMode: "local",
      modelPath,
      mmprojPath,
      draftModelPath,
      draftModelUrl,
      requiresDownload: Boolean(
        options.useDraft && !draftModelPath && draftModelUrl,
      ),
    };
  }

  const cachedAssets = resolveCachedModelAssets(options);
  return {
    ...cachedAssets,
    requiresDownload: Boolean(
      cachedAssets.requiresDownload ?? cachedAssets.launchMode !== "cached-hf",
    ),
  };
}

/** @param {ModelAssetOptions} [options] */
function isModelCached(options = {}) {
  const launchTarget = inspectModelLaunch(options);
  if (launchTarget.launchMode === "openai-codex") {
    return true;
  }
  if (launchTarget.launchMode === "openai-api") {
    return true;
  }
  if (launchTarget.launchMode === "local") {
    return Boolean(
      launchTarget.modelPath &&
      isUsableFile(launchTarget.modelPath) &&
      (!options.useDraft || launchTarget.draftModelPath),
    );
  }
  return (
    launchTarget.launchMode === "cached-hf" && !launchTarget.requiresDownload
  );
}

/** @param {unknown} value */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

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
