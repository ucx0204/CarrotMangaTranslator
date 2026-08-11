import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PageExportTempOwner<T> = {
  directory: string;
  owner: T;
  release: () => void;
};

export async function createPageExportTempOwner<T>(
  createOwner: () => T,
): Promise<PageExportTempOwner<T>> {
  // Chromium's Windows file loader can still fail near the legacy MAX_PATH
  // boundary even though Node successfully wrote the file. A short, unique
  // OS-temp directory also gives concurrent sessions explicit ownership.
  const directory = await mkdtemp(join(tmpdir(), "mgt-png-export-"));
  try {
    return {
      directory,
      owner: createOwner(),
      release: () => removePageExportTempDirectory(directory),
    };
  } catch (error) {
    let cleanupError: unknown = null;
    try {
      removePageExportTempDirectory(directory);
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Page export owner creation and temp cleanup both failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

function removePageExportTempDirectory(directory: string): void {
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 2,
    retryDelay: 25,
  });
}
