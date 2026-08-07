import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
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
import {
  MAX_SHARE_JSON_BYTES,
  openZipArchiveReader,
} from "../src/main/libraryStore/zipSafety";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("streaming share zip writer", () => {
  it("writes stored JSON and file entries readable by the current archive reader", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "normal.mgtshare");
    const sourcePath = join(rootDir, "page.png");
    await writeFile(sourcePath, Buffer.from("binary-page"));

    await writeAtomicStreamingShareArchive(
      {
        outputPath,
        archiveDate: new Date("2026-01-01T00:00:00.000Z"),
      },
      async (archive) => {
        await archive.addJson("manifest.json", { hello: "world" });
        await archive.addFile("chapters/a/pages/001.png", {
          path: sourcePath,
          size: 11,
        });
        await archive.addJson("chapters/a/chapter.json", { id: "a" });
      },
    );

    const reader = await openZipArchiveReader(outputPath, "공유 파일");
    try {
      expect([...reader.entryMap.keys()]).toEqual([
        "manifest.json",
        "chapters/a/pages/001.png",
        "chapters/a/chapter.json",
      ]);
      await expect(
        reader.readEntry("manifest.json", 1024, "manifest.json"),
      ).resolves.toEqual(Buffer.from('{\n  "hello": "world"\n}\n'));
      await expect(
        reader.readEntry(
          "chapters/a/pages/001.png",
          1024,
          "chapters/a/pages/001.png",
        ),
      ).resolves.toEqual(Buffer.from("binary-page"));
    } finally {
      reader.close();
    }
  });

  it("never has more than one active file input stream", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "sequential.mgtshare");
    const firstPath = join(rootDir, "first.png");
    const secondPath = join(rootDir, "second.png");
    await writeFile(firstPath, Buffer.alloc(256 * 1024, 1));
    await writeFile(secondPath, Buffer.alloc(256 * 1024, 2));

    let activeInputs = 0;
    let maxActiveInputs = 0;
    const runtime = createRuntime({
      createInputStream: (path, signal) => {
        const stream = createReadStream(path, {
          highWaterMark: 4 * 1024,
          ...(signal ? { signal } : {}),
        });
        activeInputs += 1;
        maxActiveInputs = Math.max(maxActiveInputs, activeInputs);
        let released = false;
        const release = () => {
          if (!released) {
            released = true;
            activeInputs -= 1;
          }
        };
        stream.once("end", release);
        stream.once("close", release);
        return stream;
      },
    });

    await writeAtomicStreamingShareArchive(
      {
        outputPath,
        archiveDate: new Date("2026-01-01T00:00:00.000Z"),
      },
      async (archive) => {
        await archive.addFile("first.png", {
          path: firstPath,
          size: 256 * 1024,
        });
        await archive.addFile("second.png", {
          path: secondPath,
          size: 256 * 1024,
        });
      },
      runtime,
    );

    expect(maxActiveInputs).toBe(1);
    expect(activeInputs).toBe(0);
  });

  it("rejects traversal and duplicate archive paths", async () => {
    const rootDir = await createTempDir();

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath: join(rootDir, "traversal.mgtshare"),
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addJson("../manifest.json", {});
        },
      ),
    ).rejects.toThrow(/안전하지 않은 경로/);

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath: join(rootDir, "duplicate.mgtshare"),
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addJson("manifest.json", {});
          await archive.addJson("manifest.json", {});
        },
      ),
    ).rejects.toThrow(/중복 항목/);
  });

  it("streams a 64 MiB source in small chunks while the event loop remains responsive", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "large-stream.mgtshare");
    const chunkSize = 64 * 1024;
    const totalSize = 64 * 1024 * 1024;
    const chunkCount = totalSize / chunkSize;
    let emittedChunks = 0;
    let tickCount = 0;
    const runtime = createRuntime({
      createInputStream: () =>
        Readable.from(
          (async function* () {
            for (let index = 0; index < chunkCount; index += 1) {
              if (index % 16 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 1));
              }
              emittedChunks += 1;
              yield Buffer.alloc(chunkSize, index % 251);
            }
          })(),
        ),
    });
    const interval = setInterval(() => {
      tickCount += 1;
    }, 5);

    try {
      await writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addFile("large.png", {
            path: "generated.png",
            size: totalSize,
          });
        },
        runtime,
      );
    } finally {
      clearInterval(interval);
    }

    expect(emittedChunks).toBe(chunkCount);
    expect(tickCount).toBeGreaterThan(0);
    const reader = await openZipArchiveReader(outputPath, "공유 파일");
    try {
      expect(reader.entryMap.get("large.png")?.header?.size).toBe(totalSize);
    } finally {
      reader.close();
    }
  }, 30_000);

  it("rejects JSON entries above the importer-compatible 20 MiB limit", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "large-json.mgtshare");

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addJson(
            "too-big.json",
            "x".repeat(MAX_SHARE_JSON_BYTES),
          );
        },
      ),
    ).rejects.toThrow(/파일이 너무 큽니다/);
  });

  it("rejects when a source file changes size after stat", async () => {
    const rootDir = await createTempDir();
    const outputPath = join(rootDir, "size-mismatch.mgtshare");
    const sourcePath = join(rootDir, "page.png");
    await writeFile(sourcePath, Buffer.from("short"));

    await expect(
      writeAtomicStreamingShareArchive(
        {
          outputPath,
          archiveDate: new Date("2026-01-01T00:00:00.000Z"),
        },
        async (archive) => {
          await archive.addFile("page.png", {
            path: sourcePath,
            size: 10,
          });
        },
      ),
    ).rejects.toThrow(/unexpected number of bytes/i);

    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "manga-share-streaming-"));
  tempDirs.push(dir);
  return dir;
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
