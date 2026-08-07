import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import * as yazl from "yazl";
import {
  writeAtomicStreamingShareArchive,
  type ShareStreamingZipRuntime,
} from "../src/main/libraryStore/shareStreamingZip";
import { openZipArchiveReader } from "../src/main/libraryStore/zipSafety";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("share export atomic output", () => {
  it("preserves an existing target and removes temp files on abort", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "abort.mgtshare");
    await writeFile(outputPath, "old export");
    const controller = new AbortController();
    const runtime = createRuntime({
      createInputStream: () =>
        new Readable({
          read() {
            this.push(Buffer.alloc(4, 1));
            controller.abort();
          },
        }),
    });

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
          signal: controller.signal,
        },
        async (archive) => {
          await archive.addFile("page.png", {
            path: "unused.png",
            size: 8,
          });
        },
        runtime,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(readFile(outputPath, "utf8")).resolves.toBe("old export");
    expect(await tempFiles(rootDir)).toEqual([]);
  });

  it("preserves an existing target when a source stream fails", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "source-error.mgtshare");
    await writeFile(outputPath, "old export");
    const runtime = createRuntime({
      createInputStream: () =>
        new Readable({
          read() {
            this.destroy(new Error("source exploded"));
          },
        }),
    });

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addFile("page.png", {
            path: "unused.png",
            size: 8,
          });
        },
        runtime,
      ),
    ).rejects.toThrow("source exploded");

    await expect(readFile(outputPath, "utf8")).resolves.toBe("old export");
    expect(await tempFiles(rootDir)).toEqual([]);
  });

  it("preserves an existing target when rename fails", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "rename-error.mgtshare");
    await writeFile(outputPath, "old export");
    const runtime = createRuntime({
      renameWithRetry: async () => {
        throw new Error("rename failed");
      },
    });

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addJson("manifest.json", { ok: true });
        },
        runtime,
      ),
    ).rejects.toThrow("rename failed");

    await expect(readFile(outputPath, "utf8")).resolves.toBe("old export");
    expect(await tempFiles(rootDir)).toEqual([]);
  });

  it("replaces an existing target only after a valid archive is complete", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "success.mgtshare");
    await writeFile(outputPath, "old export");

    await writeAtomicStreamingShareArchive(
      {
        outputPath,
        archiveDate: new Date("2026-01-01T00:00:00.000Z"),
      },
      async (archive) => {
        await archive.addJson("manifest.json", { ok: true });
      },
    );

    const reader = await openZipArchiveReader(outputPath, "공유 파일");
    try {
      expect(reader.entryMap.has("manifest.json")).toBe(true);
    } finally {
      reader.close();
    }
    expect(await tempFiles(rootDir)).toEqual([]);
  });

  it("treats a successful rename as the commit point even if abort fires immediately after", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "commit-wins.mgtshare");
    await writeFile(outputPath, "old export");
    const controller = new AbortController();
    const runtime = createRuntime({
      renameWithRetry: async (sourcePath, destinationPath) => {
        await rename(sourcePath, destinationPath);
        controller.abort();
      },
    });

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
          signal: controller.signal,
        },
        async (archive) => {
          await archive.addJson("manifest.json", { committed: true });
          return "committed";
        },
        runtime,
      ),
    ).resolves.toBe("committed");

    const reader = await openZipArchiveReader(outputPath, "공유 파일");
    try {
      expect(reader.entryMap.has("manifest.json")).toBe(true);
    } finally {
      reader.close();
    }
  });

  it("preserves both the primary failure and cleanup failure", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "cleanup-error.mgtshare");
    const runtime = createRuntime({
      rm: async () => {
        throw new Error("cleanup failed");
      },
    });

    const error = await writeAtomicStreamingShareArchive(
      {
        outputPath,
        archiveDate: new Date("2026-01-01T00:00:00.000Z"),
      },
      async () => {
        throw new Error("primary failed");
      },
      runtime,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "primary failed" }),
        expect.objectContaining({ message: "cleanup failed" }),
      ]),
    );
  });

  it("keeps AbortError as the primary error when cleanup also fails", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "abort-cleanup-error.mgtshare");
    const controller = new AbortController();
    const runtime = createRuntime({
      rm: async () => {
        throw new Error("cleanup failed");
      },
    });

    const error = await writeAtomicStreamingShareArchive(
      {
        outputPath,
        archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        signal: controller.signal,
      },
      async () => {
        controller.abort();
      },
      runtime,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(
      (error as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([expect.objectContaining({ message: "cleanup failed" })]);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "manga-share-atomic-"));
  tempDirs.push(dir);
  return dir;
}

async function tempFiles(rootDir: string): Promise<string[]> {
  return (await readdir(rootDir)).filter((name) => name.endsWith(".tmp"));
}

function createRuntime(
  overrides: Partial<ShareStreamingZipRuntime> = {},
): ShareStreamingZipRuntime {
  return {
    createZipFile: () => new yazl.ZipFile(),
    createInputStream: (path, signal) =>
      createReadStream(path, {
        highWaterMark: 64 * 1024,
        ...(signal ? { signal } : {}),
      }),
    createOutputStream: (path) =>
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    mkdir,
    rm,
    syncFile: async (path) => {
      const handle = await open(path, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    renameWithRetry: async (sourcePath, destinationPath) => {
      await rename(sourcePath, destinationPath);
    },
    createId: () => "test-id",
    ...overrides,
  };
}
