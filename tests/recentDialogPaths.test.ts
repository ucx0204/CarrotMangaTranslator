import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  rememberRecentDialogDirectory,
  rememberRecentDialogFile,
} from "../src/main/recentDialogPaths";

const tempDirs: string[] = [];
const originalLogPath = process.env.MANGA_TRANSLATOR_LOG_PATH;

afterEach(async () => {
  if (originalLogPath === undefined) {
    delete process.env.MANGA_TRANSLATOR_LOG_PATH;
  } else {
    process.env.MANGA_TRANSLATOR_LOG_PATH = originalLogPath;
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("recent dialog path storage", () => {
  it("keeps dialog kinds isolated and reloads their persisted JSON", async () => {
    const dataRoot = await makeTempDir();
    const imageDir = join(dataRoot, "images");
    const archiveDir = join(dataRoot, "archives");
    await Promise.all([
      mkdir(imageDir, { recursive: true }),
      mkdir(archiveDir, { recursive: true }),
    ]);

    rememberRecentDialogFile(
      dataRoot,
      recentDialogPathKeys.imageImport,
      join(imageDir, "page.png"),
    );
    rememberRecentDialogDirectory(
      dataRoot,
      recentDialogPathKeys.archiveFolderImport,
      archiveDir,
    );

    expect(
      getRecentDialogDirectory(dataRoot, recentDialogPathKeys.imageImport),
    ).toBe(imageDir);
    expect(
      getRecentDialogDirectory(
        dataRoot,
        recentDialogPathKeys.archiveFolderImport,
      ),
    ).toBe(archiveDir);
    expect(
      getRecentDialogDirectory(dataRoot, recentDialogPathKeys.archiveImport),
    ).toBeUndefined();

    const stored = JSON.parse(
      await readFile(join(dataRoot, "recent-dialog-paths.json"), "utf8"),
    ) as Record<string, string>;
    expect(stored).toEqual({
      imageImport: imageDir,
      archiveFolderImport: archiveDir,
    });

    vi.resetModules();
    const reloaded = await import("../src/main/recentDialogPaths");
    expect(
      reloaded.getRecentDialogDirectory(
        dataRoot,
        reloaded.recentDialogPathKeys.imageImport,
      ),
    ).toBe(imageDir);
    expect(
      reloaded.getRecentDialogDirectory(
        dataRoot,
        reloaded.recentDialogPathKeys.archiveFolderImport,
      ),
    ).toBe(archiveDir);
  });

  it("falls back to the nearest existing parent of a deleted directory", async () => {
    const dataRoot = await makeTempDir();
    const parentDir = join(dataRoot, "imports");
    const deletedChild = join(parentDir, "finished", "chapter-01");
    await mkdir(deletedChild, { recursive: true });
    rememberRecentDialogDirectory(
      dataRoot,
      recentDialogPathKeys.archiveImport,
      deletedChild,
    );

    await rm(join(parentDir, "finished"), { recursive: true, force: true });

    expect(
      getRecentDialogDirectory(dataRoot, recentDialogPathKeys.archiveImport),
    ).toBe(parentDir);
  });

  it("treats invalid JSON as empty state and remains writable", async () => {
    const dataRoot = await makeTempDir();
    const archiveDir = join(dataRoot, "archives");
    process.env.MANGA_TRANSLATOR_LOG_PATH = join(
      dataRoot,
      "state-store-errors.log",
    );
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      join(dataRoot, "recent-dialog-paths.json"),
      "{ definitely not json",
      "utf8",
    );

    expect(
      getRecentDialogDirectory(dataRoot, recentDialogPathKeys.archiveImport),
    ).toBeUndefined();

    rememberRecentDialogDirectory(
      dataRoot,
      recentDialogPathKeys.archiveImport,
      archiveDir,
    );

    await expect(readStoredPaths(dataRoot)).resolves.toEqual({
      archiveImport: archiveDir,
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recent-dialog-paths-"));
  tempDirs.push(dir);
  return dir;
}

async function readStoredPaths(
  dataRoot: string,
): Promise<Record<string, string>> {
  return JSON.parse(
    await readFile(join(dataRoot, "recent-dialog-paths.json"), "utf8"),
  ) as Record<string, string>;
}
