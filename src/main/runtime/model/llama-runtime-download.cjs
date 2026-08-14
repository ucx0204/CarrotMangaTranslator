// @ts-check
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const { mkdir, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { bundledServerCandidates } = require("../resolve-llama-runtime.cjs");
const {
  LLAMA_RUNTIME_MARKER_FILE,
  shouldExtractLlamaRuntimeFile,
} = require("../simple-page-llama-runtimes.cjs");
const {
  assertRuntimeArchiveChecksumsPresent,
  claimRuntimeArchivePaths,
  normalizeSha256,
  readExpectedRuntimeArchiveBytes,
  resolvePinnedLlamaRuntimeZipExtractionLimits,
  resolveRuntimeArchiveMaximumBytes,
} = require("./llama-runtime-archive-policy.cjs");
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
  installedRuntimeMarkerMatches,
} = require("./llama-runtime-installed-integrity.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
} = require("../simple-page-runtime-common.cjs");
const {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} = require("../runtime-directory-publish.cjs");
const {
  MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
} = require("../transport/download-budgets.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} ModelAssetOptions */
/** @typedef {{ archive: string; url: string; sha256?: string; expectedBytes?: number; type?: "zip" | "tar.gz"; stripComponents?: number }} LlamaRuntimeArchive */
/** @typedef {{ archive?: string; archives?: LlamaRuntimeArchive[]; backend?: string; platform?: string; arch?: string; dir: string; id?: string; kind?: string; requiredFiles?: Array<string | string[]>; url?: string }} LlamaRuntimeDescriptor */
/** @typedef {{ archivePath: string; archive: LlamaRuntimeArchive; sha256: string; bytes: number }} VerifiedLlamaRuntimeArchive */

/** @param {ModelAssetOptions} [options] */
async function ensureDefaultLlamaRuntimeDownloaded(options = {}) {
  const runtime = resolvePreferredLlamaRuntime(options);
  const layout = buildRuntimeLayout(options, runtime);
  if (findCurrentCompleteRuntimeDir(options, runtime)) return;
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
  const ownership = await claimRuntimeArchivePaths(archivePaths);
  try {
    const verifiedArchives = await verifyRuntimeArchiveChecksums(
      ownership.archivePaths,
      archives,
    );
    emitRuntimeInstallStart(options, runtime);
    await extractRuntimeArchives(
      layout.runtimeDir,
      verifiedArchives,
      runtime,
      options,
      ownership.restore,
    );
    assertInstalledRuntime(layout, runtime, archivePaths);
    await writeRuntimeMarker(layout.runtimeDir, runtime, archives);
    emitRuntimeInstallComplete(options, runtime);
  } finally {
    await safeCleanup(
      "restore extraction-owned llama runtime archives",
      ownership.restore,
    );
  }
}

/** @param {ModelAssetOptions} options @param {LlamaRuntimeDescriptor} runtime */
function findCurrentCompleteRuntimeDir(options, runtime) {
  return resolveLlamaRuntimeSearchDirs(options)
    .map((rootDir) => path.join(rootDir, runtime.dir))
    .find((runtimeDir) => isCurrentAndCompleteRuntime(runtimeDir, runtime));
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
    installedRuntimeMarkerMatches(
      runtimeDir,
      runtime,
      LLAMA_RUNTIME_MARKER_FILE,
    ) && hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)
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
    maximumBytes: resolveRuntimeArchiveMaximumBytes(archive),
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

/** @param {string} runtimeDir @param {VerifiedLlamaRuntimeArchive[]} verifiedArchives @param {LlamaRuntimeDescriptor} runtime @param {ModelAssetOptions} options @param {() => Promise<void>} restoreArchivesBeforePublish */
async function extractRuntimeArchives(
  runtimeDir,
  verifiedArchives,
  runtime,
  options,
  restoreArchivesBeforePublish,
) {
  const stagingDir = createRuntimeStagingDirectory(runtimeDir);
  await safeCleanup("remove stale llama runtime staging directory", () =>
    rm(stagingDir, { recursive: true, force: true }),
  );
  await mkdir(stagingDir, { recursive: true });
  try {
    for (const verification of verifiedArchives) {
      const { archivePath, archive } = verification;
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
          {
            abortSignal: options.abortSignal,
            finalOutputDir: runtimeDir,
            limits: resolvePinnedLlamaRuntimeZipExtractionLimits(
              runtime,
              archive,
              verification,
            ),
          },
        );
      }
    }
    // Re-read the extraction-owned paths after extraction. The public cache
    // names are restored only after this succeeds, so swapping and later
    // restoring a known download path cannot hide the bytes yauzl consumed.
    await verifyRuntimeArchiveChecksums(
      verifiedArchives.map(({ archivePath }) => archivePath),
      verifiedArchives.map(({ archive }) => archive),
    );
    if (!hasRequiredLlamaRuntimeFiles(stagingDir, runtime)) {
      throw createDetailedError(
        "Gemma 실행 런타임 압축에 필요한 실행 파일이 없습니다.",
        {
          stagingDir,
          missingFiles: missingRequiredLlamaRuntimeFiles(stagingDir, runtime),
        },
      );
    }
    await restoreArchivesBeforePublish();
    await replaceDirectoryWithRollback(stagingDir, runtimeDir);
  } catch (error) {
    await safeCleanup("remove rejected llama runtime staging directory", () =>
      rm(stagingDir, { recursive: true, force: true }),
    );
    throw error;
  }
}

/** @param {readonly string[]} archivePaths @param {LlamaRuntimeArchive[]} archives @returns {Promise<VerifiedLlamaRuntimeArchive[]>} */
async function verifyRuntimeArchiveChecksums(archivePaths, archives) {
  /** @type {VerifiedLlamaRuntimeArchive[]} */
  const verified = [];
  for (let index = 0; index < archivePaths.length; index += 1) {
    const archive = archives[index];
    const expected = normalizeSha256(archive?.sha256);
    if (!expected) {
      throw createDetailedError(
        "Gemma 실행 런타임에 필수 SHA-256이 없어 설치를 중단했습니다.",
        { archive: archive?.archive },
      );
    }
    const archivePath = archivePaths[index];
    const actualBytes = (await stat(archivePath)).size;
    const expectedBytes = readExpectedRuntimeArchiveBytes(archive);
    if (expectedBytes !== undefined && actualBytes !== expectedBytes) {
      await safeCleanup("remove size-mismatched llama runtime archive", () =>
        rm(archivePath, { force: true }),
      );
      throw createDetailedError(
        "Gemma 실행 런타임 압축 파일 크기가 고정된 값과 일치하지 않아 설치를 중단했습니다.",
        {
          archivePath,
          expectedBytes,
          actualBytes,
        },
      );
    }
    const actual = await calculateFileSha256(archivePath);
    if (actual === expected) {
      verified.push(
        Object.freeze({
          archivePath,
          archive: Object.freeze({ ...archive }),
          sha256: actual,
          bytes: actualBytes,
        }),
      );
      continue;
    }
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
  return verified;
}

/** @param {string} filePath */
async function calculateFileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
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
  claimRuntimeArchivePaths,
  ensureDefaultLlamaRuntimeDownloaded,
  extractRuntimeArchives,
  verifyRuntimeArchiveChecksums,
};
