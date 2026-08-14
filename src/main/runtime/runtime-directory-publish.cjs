// @ts-check
const { randomBytes } = require("node:crypto");
const { access, rename, rm } = require("node:fs/promises");
const path = require("node:path");

const WINDOWS_LEGACY_PATH_CEILING = 252;
const COMPACT_RUNTIME_TOKEN_BYTES = 8;

/**
 * Publish a fully prepared directory without discarding the last usable
 * runtime until the replacement rename succeeds. Windows cannot replace a
 * non-empty directory in one syscall, so the previous directory is retained
 * as a rollback target across the two same-volume renames.
 *
 * @param {string} stagingDir
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function replaceDirectoryWithRollback(stagingDir, outputDir) {
  assertWindowsLegacyRuntimePath(stagingDir, "runtime staging directory");
  assertWindowsLegacyRuntimePath(outputDir, "runtime output directory");
  const backupDir = createCompactRuntimeSiblingDirectory(outputDir, "b");
  await rm(backupDir, { recursive: true, force: true });
  const movedPrevious = await movePreviousDirectory(outputDir, backupDir);
  try {
    await rename(stagingDir, outputDir);
  } catch (error) {
    if (movedPrevious) {
      await rename(backupDir, outputDir);
    }
    throw error;
  }
  if (movedPrevious) {
    await removePublishedRuntimeBackup(backupDir);
  }
}

/**
 * Keep transient directories beside the destination so publication remains a
 * same-volume rename. The fixed 19-character basename also avoids repeating a
 * potentially long runtime basename in staging and backup paths.
 *
 * @param {string} outputDir
 * @param {"b" | "s" | "z"} kind
 */
function createCompactRuntimeSiblingDirectory(outputDir, kind) {
  const sibling = path.join(
    path.dirname(path.resolve(outputDir)),
    `.${kind}-${randomBytes(COMPACT_RUNTIME_TOKEN_BYTES).toString("hex")}`,
  );
  assertWindowsLegacyRuntimePath(sibling, `runtime ${kind} directory`);
  return sibling;
}

/** @param {string} outputDir */
function createRuntimeStagingDirectory(outputDir) {
  return createCompactRuntimeSiblingDirectory(outputDir, "s");
}

/**
 * Native Windows runtimes still load some DLL and kernel paths through
 * MAX_PATH-sized buffers. Extended-length namespace paths are left alone so
 * explicit Node long-path workflows retain their existing behavior.
 *
 * @param {string} filePath
 * @param {string} label
 */
function assertWindowsLegacyRuntimePath(filePath, label) {
  if (process.platform !== "win32" || isExtendedLengthPath(filePath)) return;
  const resolved = path.resolve(filePath);
  if (resolved.length < WINDOWS_LEGACY_PATH_CEILING) return;
  throw Object.assign(
    new Error(
      `${label} exceeds the Windows runtime path safety ceiling: ${resolved}`,
    ),
    {
      runtimePath: resolved,
      runtimePathLength: resolved.length,
      windowsPathCeiling: WINDOWS_LEGACY_PATH_CEILING,
      windowsPathUnsafe: true,
      nonRetriable: true,
    },
  );
}

/** @param {string} filePath */
function isExtendedLengthPath(filePath) {
  return String(filePath).startsWith("\\\\?\\");
}

/** @param {string} outputDir @param {string} backupDir @returns {Promise<boolean>} */
async function movePreviousDirectory(outputDir, backupDir) {
  try {
    await access(outputDir);
    await rename(outputDir, backupDir);
    return true;
  } catch (error) {
    if (/** @type {{ code?: unknown }} */ (error)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** @param {string} backupDir @returns {Promise<void>} */
async function removePublishedRuntimeBackup(backupDir) {
  try {
    await rm(backupDir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      "[manga-runtime] Cleanup failed: remove replaced runtime directory",
      error,
    );
  }
}

module.exports = {
  WINDOWS_LEGACY_PATH_CEILING,
  assertWindowsLegacyRuntimePath,
  createCompactRuntimeSiblingDirectory,
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
};
