// @ts-check
const { createReadStream, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { mkdir, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { bundledServerCandidates } = require("../resolve-llama-runtime.cjs");
const {
  LLAMA_RUNTIME_MARKER_FILE,
  shouldExtractLlamaRuntimeFile,
} = require("../simple-page-llama-runtimes.cjs");
const {
  downloadHfFileWithProgress,
  mapWithConcurrency,
  probeContentLength,
  resolveDownloadRangeConcurrency,
} = require("../simple-page-download-utils.cjs");
const {
  hasRequiredLlamaRuntimeFiles,
  missingRequiredLlamaRuntimeFiles,
  resolveLlamaRuntimeSearchDirs,
  resolveManagedToolsDir,
  resolvePreferredLlamaRuntime,
  resolveToolsDir,
  serverBinaryName,
} = require("../simple-page-runtime-paths.cjs");
const { extractSelectedZipEntries } = require("../simple-page-zip-utils.cjs");
const { extractSelectedTarEntries } = require("../simple-page-tar-utils.cjs");
const {
  collectInstalledRuntimeFileHashes,
  installedRuntimeHashesMatch,
} = require("./llama-runtime-installed-integrity.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  replaceDirectoryWithRollback,
} = require("../runtime-directory-publish.cjs");
const {
  MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
} = require("../transport/download-budgets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} ModelAssetOptions */
/** @typedef {{ archive: string; url: string; sha256?: string; type?: "zip" | "tar.gz"; stripComponents?: number }} LlamaRuntimeArchive */
/** @typedef {{ archive?: string; archives?: LlamaRuntimeArchive[]; backend?: string; platform?: string; arch?: string; dir: string; id?: string; kind?: string; requiredFiles?: Array<string | string[]>; url?: string }} LlamaRuntimeDescriptor */
/** @typedef {{ archive?: unknown; url?: unknown; sha256?: unknown }} MarkerArchive */

/** @param {ModelAssetOptions} [options] */
async function ensureDefaultLlamaRuntimeDownloaded(options = {}) {
  const runtime = resolvePreferredLlamaRuntime(options);
  const layout = buildRuntimeLayout(options, runtime);
  if (isCurrentAndCompleteRuntime(layout.runtimeDir, runtime)) return;
  assertRuntimeCanBeInstalled(options, layout);
  const archives = getLlamaRuntimeArchives(runtime);
  assertRuntimeArchiveChecksumsPresent(archives);
  const totals = await collectArchiveTotals(archives, options.abortSignal);
  const aggregate = buildArchiveAggregate(totals, archives.length);
  const archivePaths = await downloadRuntimeArchives(
    options,
    runtime,
    layout.downloadsDir,
    archives,
    totals,
    aggregate,
  );
  await verifyRuntimeArchiveChecksums(archivePaths, archives);
  emitRuntimeInstallStart(options, runtime);
  await extractRuntimeArchives(
    layout.runtimeDir,
    archivePaths,
    archives,
    runtime,
    options,
  );
  // Re-read every archive after extraction to close the download/extract TOCTOU
  // window before any extracted executable is accepted.
  await verifyRuntimeArchiveChecksums(archivePaths, archives);
  assertInstalledRuntime(layout, runtime, archivePaths);
  await writeRuntimeMarker(layout.runtimeDir, runtime, archives);
  emitRuntimeInstallComplete(options, runtime);
}

/** @param {ModelAssetOptions} options @param {LlamaRuntimeDescriptor} runtime */
function buildRuntimeLayout(options, runtime) {
  const managedToolsDir = resolveManagedToolsDir(options);
  const runtimeDir = path.join(managedToolsDir, runtime.dir);
  return {
    managedToolsDir,
    runtimeDir,
    downloadsDir: path.join(managedToolsDir, ".downloads"),
    serverPath: path.join(runtimeDir, serverBinaryName()),
  };
}

/** @param {string} runtimeDir @param {LlamaRuntimeDescriptor} runtime */
function isCurrentAndCompleteRuntime(runtimeDir, runtime) {
  return (
    isCurrentLlamaRuntime(runtimeDir, runtime) &&
    hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)
  );
}

/** @param {ModelAssetOptions} options @param {ReturnType<typeof buildRuntimeLayout>} layout */
function assertRuntimeCanBeInstalled(options, layout) {
  if (process.platform === "win32") return;
  if (process.platform === "darwin" && process.arch === "arm64") return;
  throw createDetailedError("Bundled llama-server binary is missing.", {
    serverPath: layout.serverPath,
    toolsDir: resolveToolsDir(options),
    managedToolsDir: layout.managedToolsDir,
    checkedServerPaths: resolveLlamaRuntimeSearchDirs(options).flatMap((dir) =>
      bundledServerCandidates(dir),
    ),
  });
}

/** @param {LlamaRuntimeArchive[]} archives @param {AbortSignal | null | undefined} signal */
async function collectArchiveTotals(archives, signal) {
  const totals = new Map();
  const probes = await mapWithConcurrency(
    archives,
    resolveDownloadRangeConcurrency(),
    async (archive) => ({
      archive,
      totalBytes: await probeContentLength(
        archive.url,
        signal,
        MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
      ),
    }),
  );
  for (const { archive, totalBytes } of probes) {
    if (Number.isFinite(totalBytes) && totalBytes > 0)
      totals.set(archive.archive, totalBytes);
  }
  return totals;
}

/** @param {Map<string, number>} totals @param {number} archiveCount */
function buildArchiveAggregate(totals, archiveCount) {
  const totalBytes = [...totals.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  return { totalBytes, known: totalBytes > 0 && totals.size === archiveCount };
}

/** @param {ModelAssetOptions} options @param {LlamaRuntimeDescriptor} runtime @param {string} downloadsDir @param {LlamaRuntimeArchive[]} archives @param {Map<string, number>} totals @param {ReturnType<typeof buildArchiveAggregate>} aggregate */
async function downloadRuntimeArchives(
  options,
  runtime,
  downloadsDir,
  archives,
  totals,
  aggregate,
) {
  let completedBytes = 0;
  const paths = [];
  for (const archive of archives) {
    const archivePath = path.join(downloadsDir, archive.archive);
    paths.push(archivePath);
    const totalBytes = totals.get(archive.archive) || 0;
    await downloadHfFileWithProgress(
      buildRuntimeDownloadTask(runtime, archive, archivePath),
      options,
      {
        totalBytes,
        knownAggregateBytes: aggregate.known ? aggregate.totalBytes : 0,
        completedBytes,
        onComplete: (bytesWritten) => {
          completedBytes += aggregate.known ? totalBytes : bytesWritten;
        },
      },
    );
  }
  return paths;
}

/** @param {LlamaRuntimeDescriptor} runtime @param {LlamaRuntimeArchive} archive @param {string} destination */
function buildRuntimeDownloadTask(runtime, archive, destination) {
  return {
    kind: "llama-runtime",
    label: `Gemma 실행 런타임 (${runtime.kind})`,
    file: archive.archive,
    url: archive.url,
    destination,
    maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
    progressPhase: "model_downloading",
    progressTitle: "Gemma 실행 런타임 다운로드 중",
    completeTitle: "Gemma 실행 런타임 다운로드 완료",
  };
}

/** @param {ModelAssetOptions} options @param {LlamaRuntimeDescriptor} runtime */
function emitRuntimeInstallStart(options, runtime) {
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
}

/** @param {string} runtimeDir @param {string[]} archivePaths @param {LlamaRuntimeArchive[]} archives @param {LlamaRuntimeDescriptor} runtime @param {ModelAssetOptions} options */
async function extractRuntimeArchives(
  runtimeDir,
  archivePaths,
  archives,
  runtime,
  options,
) {
  const stagingDir = `${runtimeDir}.staging-${process.pid}-${Date.now()}`;
  await safeCleanup("remove stale llama runtime staging directory", () =>
    rm(stagingDir, { recursive: true, force: true }),
  );
  await mkdir(stagingDir, { recursive: true });
  try {
    for (let index = 0; index < archivePaths.length; index += 1) {
      const archivePath = archivePaths[index];
      const archive = archives[index];
      if (archive?.type === "tar.gz" || /\.tar\.gz$/i.test(archivePath)) {
        await extractSelectedTarEntries(
          archivePath,
          stagingDir,
          shouldExtractLlamaRuntimeFile,
          {
            stripComponents: archive?.stripComponents,
            abortSignal: options.abortSignal,
          },
        );
      } else {
        await extractSelectedZipEntries(
          archivePath,
          stagingDir,
          shouldExtractLlamaRuntimeFile,
          { abortSignal: options.abortSignal },
        );
      }
    }
    await verifyRuntimeArchiveChecksums(archivePaths, archives);
    if (!hasRequiredLlamaRuntimeFiles(stagingDir, runtime)) {
      throw createDetailedError(
        "Gemma 실행 런타임 압축에 필요한 실행 파일이 없습니다.",
        {
          stagingDir,
          missingFiles: missingRequiredLlamaRuntimeFiles(stagingDir, runtime),
        },
      );
    }
    await replaceDirectoryWithRollback(stagingDir, runtimeDir);
  } catch (error) {
    await safeCleanup("remove rejected llama runtime staging directory", () =>
      rm(stagingDir, { recursive: true, force: true }),
    );
    throw error;
  }
}

/** @param {string[]} archivePaths @param {LlamaRuntimeArchive[]} archives */
async function verifyRuntimeArchiveChecksums(archivePaths, archives) {
  for (let index = 0; index < archivePaths.length; index += 1) {
    const expected = normalizeSha256(archives[index]?.sha256);
    if (!expected) {
      throw createDetailedError(
        "Gemma 실행 런타임에 필수 SHA-256이 없어 설치를 중단했습니다.",
        { archive: archives[index]?.archive },
      );
    }
    const archivePath = archivePaths[index];
    const actual = await calculateFileSha256(archivePath);
    if (actual === expected) continue;
    await safeCleanup("remove checksum-mismatched llama runtime archive", () =>
      rm(archivePath, { force: true }),
    );
    throw createDetailedError(
      "Gemma 실행 런타임 체크섬이 일치하지 않아 설치를 중단했습니다.",
      {
        archivePath,
        expectedSha256: expected,
        actualSha256: actual,
      },
    );
  }
}

/** @param {LlamaRuntimeArchive[]} archives */
function assertRuntimeArchiveChecksumsPresent(archives) {
  if (archives.length === 0) {
    throw new Error("Gemma 실행 런타임 archive descriptor가 비어 있습니다.");
  }
  for (const archive of archives) {
    if (!normalizeSha256(archive.sha256)) {
      throw createDetailedError(
        "Gemma 실행 런타임 descriptor에 유효한 SHA-256이 필요합니다.",
        { archive: archive.archive, url: archive.url },
      );
    }
  }
}

/** @param {string} filePath */
async function calculateFileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** @param {unknown} value */
function normalizeSha256(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

/** @param {ReturnType<typeof buildRuntimeLayout>} layout @param {LlamaRuntimeDescriptor} runtime @param {string[]} archivePaths */
function assertInstalledRuntime(layout, runtime, archivePaths) {
  const missingFiles = missingRequiredLlamaRuntimeFiles(
    layout.runtimeDir,
    runtime,
  );
  if (missingFiles.length === 0) return;
  throw createDetailedError(
    "Gemma 실행 런타임을 설치했지만 필수 실행 파일 또는 GPU 런타임 파일을 찾지 못했습니다.",
    {
      archives: archivePaths,
      runtimeDir: layout.runtimeDir,
      serverPath: layout.serverPath,
      missingFiles,
    },
  );
}

/** @param {string} runtimeDir @param {LlamaRuntimeDescriptor} runtime @param {LlamaRuntimeArchive[]} archives */
function writeRuntimeMarker(runtimeDir, runtime, archives) {
  const marker = {
    id: runtime.id,
    kind: runtime.kind,
    dir: runtime.dir,
    archives,
    requiredFiles: runtime.requiredFiles,
    installedFileSha256: collectInstalledRuntimeFileHashes(runtimeDir),
    installedAt: new Date().toISOString(),
  };
  return writeFile(
    path.join(runtimeDir, LLAMA_RUNTIME_MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
}

/** @param {ModelAssetOptions} options @param {LlamaRuntimeDescriptor} runtime */
function emitRuntimeInstallComplete(options, runtime) {
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
  if (backend === "vulkan") return "Vulkan";
  if (backend === "metal") return "Metal";
  if (backend === "rocm" || backend === "hip") return "ROCm/HIP";
  return "CUDA";
}

/** @param {string} runtimeDir @param {LlamaRuntimeDescriptor} runtime */
function isCurrentLlamaRuntime(runtimeDir, runtime) {
  try {
    const marker =
      /** @type {{ id?: unknown; kind?: unknown; dir?: unknown; archives?: MarkerArchive[]; installedFileSha256?: unknown }} */ (
        JSON.parse(
          readFileSync(
            path.join(runtimeDir, LLAMA_RUNTIME_MARKER_FILE),
            "utf8",
          ),
        )
      );
    return markerMatchesRuntime(marker, runtime, runtimeDir);
  } catch (_error) {
    return false;
  }
}

/** @param {{ id?: unknown; kind?: unknown; dir?: unknown; archives?: MarkerArchive[]; installedFileSha256?: unknown }} marker @param {LlamaRuntimeDescriptor} runtime @param {string} runtimeDir */
function markerMatchesRuntime(marker, runtime, runtimeDir) {
  if (
    marker.id !== runtime.id ||
    marker.kind !== runtime.kind ||
    marker.dir !== runtime.dir
  )
    return false;
  const markerArchives = Array.isArray(marker.archives) ? marker.archives : [];
  const archivesMatch = getLlamaRuntimeArchives(runtime).every((archive) =>
    markerArchives.some(
      (candidate) =>
        candidate.archive === archive.archive &&
        candidate.url === archive.url &&
        candidate.sha256 === archive.sha256,
    ),
  );
  return (
    archivesMatch &&
    installedRuntimeHashesMatch(runtimeDir, marker.installedFileSha256)
  );
}

/** @param {LlamaRuntimeDescriptor | null | undefined} runtime @returns {LlamaRuntimeArchive[]} */
function getLlamaRuntimeArchives(runtime) {
  if (Array.isArray(runtime?.archives) && runtime.archives.length > 0)
    return runtime.archives;
  return runtime?.archive && runtime.url
    ? [{ archive: runtime.archive, url: runtime.url }]
    : [];
}

module.exports = {
  assertRuntimeArchiveChecksumsPresent,
  calculateFileSha256,
  ensureDefaultLlamaRuntimeDownloaded,
  verifyRuntimeArchiveChecksums,
};
