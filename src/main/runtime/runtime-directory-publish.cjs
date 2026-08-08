// @ts-check
const { access, rename, rm } = require("node:fs/promises");

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
  const backupDir = `${outputDir}.backup-${process.pid}-${Date.now()}`;
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

module.exports = { replaceDirectoryWithRollback };
