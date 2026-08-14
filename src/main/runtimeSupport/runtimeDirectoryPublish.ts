import { randomBytes } from "node:crypto";
import { access, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const WINDOWS_LEGACY_PATH_CEILING = 252;
const COMPACT_RUNTIME_TOKEN_BYTES = 8;

/**
 * Publishes a fully prepared directory while retaining the previous runtime
 * as a same-volume rollback target until the replacement rename succeeds.
 */
export async function replaceDirectoryWithRollback(
  stagingDir: string,
  outputDir: string,
): Promise<void> {
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

export function createRuntimeStagingDirectory(outputDir: string): string {
  return createCompactRuntimeSiblingDirectory(outputDir, "s");
}

function createCompactRuntimeSiblingDirectory(
  outputDir: string,
  kind: "b" | "s",
): string {
  const sibling = resolve(
    dirname(resolve(outputDir)),
    `.${kind}-${randomBytes(COMPACT_RUNTIME_TOKEN_BYTES).toString("hex")}`,
  );
  assertWindowsLegacyRuntimePath(sibling, `runtime ${kind} directory`);
  return sibling;
}

function assertWindowsLegacyRuntimePath(filePath: string, label: string): void {
  if (process.platform !== "win32" || String(filePath).startsWith("\\\\?\\")) {
    return;
  }
  const absolutePath = resolve(filePath);
  if (absolutePath.length < WINDOWS_LEGACY_PATH_CEILING) {
    return;
  }
  throw Object.assign(
    new Error(
      `${label} exceeds the Windows runtime path safety ceiling: ${absolutePath}`,
    ),
    {
      runtimePath: absolutePath,
      runtimePathLength: absolutePath.length,
      windowsPathCeiling: WINDOWS_LEGACY_PATH_CEILING,
      windowsPathUnsafe: true,
      nonRetriable: true,
    },
  );
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
