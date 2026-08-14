// @ts-check
const { createWriteStream } = require("node:fs");
const { mkdir, rename, rm } = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/**
 * app-runtime is copied outside app.asar, so ordinary CommonJS lookup cannot
 * see production dependencies stored inside the archive. Development uses the
 * repository node_modules directly; packaged apps retry from the ASAR root.
 *
 * @typedef {(specifier: string) => unknown} RuntimeRequire
 * @typedef {(filename: string) => RuntimeRequire} PackagedRequireFactory
 *
 * @param {{ moduleRequire?: RuntimeRequire; resourcesPath?: string; createPackagedRequire?: PackagedRequireFactory }} [options]
 */
function loadYauzlRuntime(options = {}) {
  const moduleRequire = options.moduleRequire ?? require;
  try {
    return moduleRequire("yauzl");
  } catch (error) {
    const resourcesPath =
      options.resourcesPath ??
      /** @type {NodeJS.Process & { resourcesPath?: string }} */ (process)
        .resourcesPath;
    if (!isMissingDirectYauzlModule(error) || !resourcesPath) {
      throw error;
    }
    const packagedRequire = (options.createPackagedRequire ?? createRequire)(
      path.join(resourcesPath, "app.asar", "package.json"),
    );
    return packagedRequire("yauzl");
  }
}

/** @param {unknown} error */
function isMissingDirectYauzlModule(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND" &&
    /Cannot find module ['"]yauzl['"]/.test(error.message)
  );
}

const yauzl = /** @type {typeof import("yauzl")} */ (loadYauzlRuntime());

const {
  addArchiveEntryToBudget,
  createArchiveExtractionDeadline,
  resolveArchiveExtractionLimits,
  throwIfArchiveExtractionAborted,
} = require("./archive-extraction-policy.cjs");
const { safeCleanup } = require("./simple-page-runtime-common.cjs");
const {
  assertWindowsLegacyRuntimePath,
  createCompactRuntimeSiblingDirectory,
  replaceDirectoryWithRollback,
} = require("./runtime-directory-publish.cjs");

/**
 * @typedef {{ filePath: string; outputName: string }} SelectedRuntimeFile
 * @typedef {{ entry: any; outputName: string }} InspectedZipEntry
 * @typedef {(name: string, relativePath: string) => boolean} RuntimeEntryFilter
 * @typedef {{ maximumEntries?: number; maximumEntryBytes?: number; maximumExpandedBytes?: number; maximumCompressionRatio?: number }} ArchiveExtractionLimitOverrides
 * @typedef {{ abortSignal?: AbortSignal | null; deadlineMs?: number; finalOutputDir?: string; limits?: ArchiveExtractionLimitOverrides; preserveRelativePaths?: boolean; replaceOutputDir?: boolean }} ExtractSelectedZipOptions
 * @typedef {{ label: string; root: string }} WindowsZipPathRoot
 */

/**
 * Extract only selected regular files after a complete central-directory pass.
 * The temporary directory prevents rejected archives from publishing files.
 *
 * @param {string} archivePath
 * @param {string} outputDir
 * @param {RuntimeEntryFilter} shouldExtract
 * @param {ExtractSelectedZipOptions} [options]
 */
async function extractSelectedZipEntries(
  archivePath,
  outputDir,
  shouldExtract,
  options = {},
) {
  const extractDir = createCompactRuntimeSiblingDirectory(outputDir, "z");
  const windowsPathRoots = resolveWindowsZipPathRoots(
    extractDir,
    outputDir,
    options,
  );
  await safeCleanup("remove previous runtime extract directory", () =>
    rm(extractDir, { recursive: true, force: true }),
  );
  await mkdir(extractDir, { recursive: true });
  try {
    const deadline = createArchiveExtractionDeadline(
      options.abortSignal,
      options.deadlineMs,
    );
    const limits = resolveArchiveExtractionLimits(options.limits);
    try {
      const selectedFiles = await extractSelectedZipStreams(
        archivePath,
        extractDir,
        shouldExtract,
        deadline.signal,
        options.preserveRelativePaths === true,
        limits,
        windowsPathRoots,
      );
      if (options.replaceOutputDir) {
        await replaceDirectoryWithRollback(extractDir, outputDir);
      } else {
        await publishSelectedFiles(selectedFiles, outputDir);
      }
    } finally {
      deadline.cleanup();
    }
  } finally {
    await safeCleanup("remove runtime extract directory", () =>
      rm(extractDir, { recursive: true, force: true }),
    );
  }
}

/** @param {SelectedRuntimeFile[]} selectedFiles @param {string} outputDir */
async function publishSelectedFiles(selectedFiles, outputDir) {
  const resolvedOutputDir = path.resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  for (const selected of selectedFiles) {
    const outputPath = path.join(outputDir, selected.outputName);
    if (!isPathInside(path.resolve(outputPath), resolvedOutputDir)) {
      throw new Error(`Invalid runtime output path: ${selected.outputName}`);
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    // extractDir is created beside outputDir, so publication stays on one
    // volume. Removing the exact destination preserves the previous overwrite
    // behavior on Windows while rename avoids a second multi-gigabyte write.
    await rm(outputPath, { force: true });
    await rename(selected.filePath, outputPath);
  }
}

/** @param {string} archivePath @param {string} extractDir @param {RuntimeEntryFilter} shouldExtract @param {AbortSignal} signal @param {boolean} preserveRelativePaths @param {{ maximumEntries: number; maximumEntryBytes: number; maximumExpandedBytes: number; maximumCompressionRatio: number }} limits @param {WindowsZipPathRoot[]} windowsPathRoots */
async function extractSelectedZipStreams(
  archivePath,
  extractDir,
  shouldExtract,
  signal,
  preserveRelativePaths,
  limits,
  windowsPathRoots,
) {
  throwIfArchiveExtractionAborted(signal);
  const zipFile = await yauzl.openPromise(archivePath, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    const selected = await inspectZipEntries(
      zipFile,
      archivePath,
      shouldExtract,
      signal,
      preserveRelativePaths,
      limits,
      windowsPathRoots,
    );
    if (selected.length === 0) {
      throw createDetailedError(`No runtime files matched in ${archivePath}.`, {
        archivePath,
        extractionMethod: "yauzl",
      });
    }
    return await extractInspectedZipEntries(
      zipFile,
      selected,
      extractDir,
      signal,
    );
  } finally {
    zipFile.close();
  }
}

/** @param {any} zipFile @param {string} archivePath @param {RuntimeEntryFilter} shouldExtract @param {AbortSignal} signal @param {boolean} preserveRelativePaths @param {{ maximumEntries: number; maximumEntryBytes: number; maximumExpandedBytes: number; maximumCompressionRatio: number }} limits @param {WindowsZipPathRoot[]} windowsPathRoots @returns {Promise<InspectedZipEntry[]>} */
async function inspectZipEntries(
  zipFile,
  archivePath,
  shouldExtract,
  signal,
  preserveRelativePaths,
  limits,
  windowsPathRoots,
) {
  const budget = { entryCount: 0, expandedBytes: 0 };
  const outputNames = new Set();
  /** @type {InspectedZipEntry[]} */
  const selected = [];
  for await (const entry of zipFile.eachEntry()) {
    throwIfArchiveExtractionAborted(signal);
    const relativePath = normalizeSafeZipPath(entry.fileName);
    const directory = entry.fileName.endsWith("/");
    assertSupportedZipEntry(entry, directory, archivePath);
    addArchiveEntryToBudget(
      budget,
      {
        name: relativePath,
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        directory,
      },
      path.basename(archivePath),
      limits,
    );
    if (directory) continue;
    const fileName = path.posix.basename(relativePath);
    if (!shouldExtract(fileName, relativePath)) continue;
    const outputName =
      preserveRelativePaths || shouldPreserveRuntimeRelativePath(relativePath)
        ? relativePath
        : fileName;
    assertSelectedWindowsPathBudget(outputName, windowsPathRoots);
    const foldedOutput = outputName.toLowerCase();
    if (outputNames.has(foldedOutput)) {
      throw new Error(
        `Runtime zip archive has duplicate output: ${outputName}`,
      );
    }
    outputNames.add(foldedOutput);
    selected.push({ entry, outputName });
  }
  return selected;
}

/**
 * Validate every path that the selected entry can occupy: its extraction
 * source, its immediate output, and the final/rollback roots supplied by a
 * caller that stages another atomic directory publication.
 *
 * @param {string} outputName
 * @param {WindowsZipPathRoot[]} roots
 */
function assertSelectedWindowsPathBudget(outputName, roots) {
  for (const { label, root } of roots) {
    assertWindowsLegacyRuntimePath(path.join(root, outputName), label);
  }
}

/**
 * @param {string} extractDir
 * @param {string} outputDir
 * @param {ExtractSelectedZipOptions} options
 * @returns {WindowsZipPathRoot[]}
 */
function resolveWindowsZipPathRoots(extractDir, outputDir, options) {
  if (process.platform !== "win32") return [];
  /** @type {WindowsZipPathRoot[]} */
  const roots = [
    { label: "runtime ZIP extraction path", root: extractDir },
    { label: "runtime ZIP output path", root: outputDir },
  ];
  if (options.replaceOutputDir) {
    roots.push({
      label: "runtime ZIP output backup path",
      root: createCompactRuntimeSiblingDirectory(outputDir, "b"),
    });
  }
  if (options.finalOutputDir) {
    roots.push(
      {
        label: "runtime ZIP final path",
        root: options.finalOutputDir,
      },
      {
        label: "runtime ZIP final backup path",
        root: createCompactRuntimeSiblingDirectory(options.finalOutputDir, "b"),
      },
    );
  }
  return roots;
}

/** @param {any} zipFile @param {InspectedZipEntry[]} selected @param {string} extractDir @param {AbortSignal} signal @returns {Promise<SelectedRuntimeFile[]>} */
async function extractInspectedZipEntries(
  zipFile,
  selected,
  extractDir,
  signal,
) {
  /** @type {SelectedRuntimeFile[]} */
  const files = [];
  for (const item of selected) {
    throwIfArchiveExtractionAborted(signal);
    const outputPath = path.join(extractDir, item.outputName);
    if (!isPathInside(path.resolve(outputPath), path.resolve(extractDir))) {
      throw new Error(`Invalid runtime output path: ${item.outputName}`);
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    const input = await zipFile.openReadStreamPromise(item.entry);
    let actualBytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        actualBytes += chunk.length;
        if (actualBytes > item.entry.uncompressedSize) {
          callback(
            new Error(
              `Runtime zip entry exceeded its declared size: ${item.outputName}`,
            ),
          );
        } else callback(null, chunk);
      },
    });
    await pipeline(
      input,
      meter,
      createWriteStream(outputPath, { mode: 0o600 }),
      {
        signal,
      },
    );
    if (actualBytes !== item.entry.uncompressedSize) {
      throw new Error(`Runtime zip entry size mismatch: ${item.outputName}`);
    }
    files.push({ filePath: outputPath, outputName: item.outputName });
  }
  return files;
}

/** @param {any} entry @param {boolean} directory @param {string} archivePath */
function assertSupportedZipEntry(entry, directory, archivePath) {
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0) return;
  if (directory && fileType === 0o040000) return;
  if (!directory && fileType === 0o100000) return;
  throw new Error(
    `${path.basename(archivePath)} contains a link or special entry: ${entry.fileName}`,
  );
}

/** @param {string} rawPath */
function normalizeSafeZipPath(rawPath) {
  const value = String(rawPath || "").replace(/\\/g, "/");
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`Runtime zip archive contains an unsafe path: ${rawPath}`);
  }
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Runtime zip archive contains an unsafe path: ${rawPath}`);
  }
  return parts.join("/");
}

/** @param {string} relativePath */
function shouldPreserveRuntimeRelativePath(relativePath) {
  const normalized = String(relativePath || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.startsWith("rocblas/") || normalized.startsWith("hipblaslt/")
  );
}

/** @param {string} message @param {Record<string, unknown>} detail */
function createDetailedError(message, detail) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(message)
  );
  Object.assign(error, detail);
  return error;
}

/** @param {string} childPath @param {string} parentPath */
function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

module.exports = {
  extractSelectedZipEntries,
  loadYauzlRuntime,
  normalizeSafeZipPath,
};
