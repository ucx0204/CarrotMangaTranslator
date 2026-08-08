// @ts-check
const { createWriteStream, readdirSync } = require("node:fs");
const { copyFile, mkdir, rm } = require("node:fs/promises");
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
  replaceDirectoryWithRollback,
} = require("./runtime-directory-publish.cjs");

/**
 * @typedef {{ filePath: string; outputName: string }} SelectedRuntimeFile
 * @typedef {{ entry: any; outputName: string }} InspectedZipEntry
 * @typedef {(name: string, relativePath: string) => boolean} RuntimeEntryFilter
 * @typedef {{ command: string, args: string[], code: number | null, stdout: string, stderr: string, error?: string }} ArchiveCommandAttempt
 * @typedef {{ method: "powershell" | "tar" | "yauzl", stdout: string, stderr: string, attempts: ArchiveCommandAttempt[] }} ArchiveExtractionResult
 * @typedef {(archivePath: string, outputDir: string) => Promise<ArchiveExtractionResult>} ArchiveExtractor
 * @typedef {{ maximumEntries?: number; maximumEntryBytes?: number; maximumExpandedBytes?: number; maximumCompressionRatio?: number }} ArchiveExtractionLimitOverrides
 * @typedef {{ extractArchive?: ArchiveExtractor; abortSignal?: AbortSignal | null; deadlineMs?: number; limits?: ArchiveExtractionLimitOverrides; preserveRelativePaths?: boolean; replaceOutputDir?: boolean }} ExtractSelectedZipOptions
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
  const extractDir = path.join(
    path.dirname(outputDir),
    `${path.basename(outputDir)}.extract-${process.pid}-${Date.now()}`,
  );
  await safeCleanup("remove previous runtime extract directory", () =>
    rm(extractDir, { recursive: true, force: true }),
  );
  await mkdir(extractDir, { recursive: true });
  try {
    if (options.extractArchive) {
      await extractWithInjectedExtractor(
        archivePath,
        outputDir,
        extractDir,
        shouldExtract,
        options.extractArchive,
      );
      return;
    }
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

/** @param {string} archivePath @param {string} outputDir @param {string} extractDir @param {RuntimeEntryFilter} shouldExtract @param {ArchiveExtractor} extractArchive */
async function extractWithInjectedExtractor(
  archivePath,
  outputDir,
  extractDir,
  shouldExtract,
  extractArchive,
) {
  const extraction = await extractArchive(archivePath, extractDir);
  const selectedFiles = collectSelectedFiles(extractDir, shouldExtract);
  if (selectedFiles.length === 0) {
    throw createDetailedError(
      `No runtime files matched in ${archivePath}. Archive extraction completed but produced no supported runtime files.`,
      {
        archivePath,
        extractDir,
        stdout: truncateText(extraction.stdout.trim()),
        stderr: truncateText(extraction.stderr.trim()),
        extractedTopLevelEntries: readTopLevelEntries(extractDir),
        extractionMethod: extraction.method,
        extractionAttempts: extraction.attempts,
      },
    );
  }
  await publishSelectedFiles(selectedFiles, outputDir);
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
    await copyFile(selected.filePath, outputPath);
  }
}

/** @param {string} archivePath @param {string} extractDir @param {RuntimeEntryFilter} shouldExtract @param {AbortSignal} signal @param {boolean} preserveRelativePaths @param {{ maximumEntries: number; maximumEntryBytes: number; maximumExpandedBytes: number; maximumCompressionRatio: number }} limits */
async function extractSelectedZipStreams(
  archivePath,
  extractDir,
  shouldExtract,
  signal,
  preserveRelativePaths,
  limits,
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

/** @param {any} zipFile @param {string} archivePath @param {RuntimeEntryFilter} shouldExtract @param {AbortSignal} signal @param {boolean} preserveRelativePaths @param {{ maximumEntries: number; maximumEntryBytes: number; maximumExpandedBytes: number; maximumCompressionRatio: number }} limits @returns {Promise<InspectedZipEntry[]>} */
async function inspectZipEntries(
  zipFile,
  archivePath,
  shouldExtract,
  signal,
  preserveRelativePaths,
  limits,
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

/** @param {string} rootDir @param {RuntimeEntryFilter} shouldExtract @returns {SelectedRuntimeFile[]} */
function collectSelectedFiles(rootDir, shouldExtract) {
  /** @type {SelectedRuntimeFile[]} */
  const selected = [];
  const stack = [{ dir: rootDir, relativeDir: "" }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current.dir, entry.name);
      const relativePath = current.relativeDir
        ? path.join(current.relativeDir, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        stack.push({ dir: filePath, relativeDir: relativePath });
      } else if (entry.isFile() && shouldExtract(entry.name, relativePath)) {
        selected.push({
          filePath,
          outputName: shouldPreserveRuntimeRelativePath(relativePath)
            ? relativePath
            : entry.name,
        });
      }
    }
  }
  return selected;
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

/** @param {string} rootDir */
function readTopLevelEntries(rootDir) {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch (_error) {
    return [];
  }
}

/** @param {unknown} value @param {number} [maxLength] */
function truncateText(value, maxLength = 4000) {
  const text = String(value ?? "");
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
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
  collectSelectedFiles,
  extractSelectedZipEntries,
  loadYauzlRuntime,
  normalizeSafeZipPath,
};
