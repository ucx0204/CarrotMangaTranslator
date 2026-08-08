import { access, rename, rm } from "node:fs/promises";

/**
 * Publishes a fully prepared directory while retaining the previous runtime
 * as a same-volume rollback target until the replacement rename succeeds.
 */
export async function replaceDirectoryWithRollback(
  stagingDir: string,
  outputDir: string,
): Promise<void> {
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

async function movePreviousDirectory(
  outputDir: string,
  backupDir: string,
): Promise<boolean> {
  try {
    await access(outputDir);
    await rename(outputDir, backupDir);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removePublishedRuntimeBackup(backupDir: string): Promise<void> {
  try {
    await rm(backupDir, { recursive: true, force: true });
  } catch (_error) {
    console.warn("[manga-runtime] Failed to remove replaced runtime backup");
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
