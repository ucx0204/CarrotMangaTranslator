import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportImageRuntime } from "../src/main/libraryStore/importImageRuntime";
import type { ZipArchiveReader } from "../src/main/libraryStore/zipSafety";

const tempDirs: string[] = [];

describe("ZIP reader cancellation ownership", () => {
  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("yauzl");
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes a reader when cancellation arrives as archive opening resolves", async () => {
    const rootDir = await createTempDirectory();
    const pagesDir = join(rootDir, "pages");
    const archivePath = join(rootDir, "cancel-after-open.zip");
    await mkdir(pagesDir, { recursive: true });

    const controller = new AbortController();
    const close = vi.fn();
    const openReadStreamPromise = vi.fn();
    const rawEntry = {
      fileName: "001.png",
      uncompressedSize: 4,
      compressedSize: 4,
    };

    vi.doMock("yauzl", () => ({
      openPromise: vi.fn(async () => ({
        eachEntry: async function* () {
          yield rawEntry;
          controller.abort(
            new DOMException("cancel while opening zip", "AbortError"),
          );
        },
        openReadStreamPromise,
        close,
      })),
    }));

    const { materializePageRecord } =
      await import("../src/main/libraryStore/importPageMaterialize");
    const zipReaderCache = new Map<string, ZipArchiveReader>();
    const imageRuntime: ImportImageRuntime = {
      validateImageFile: vi.fn(async () => undefined),
      convertWebpToPngFile: vi.fn(async () => undefined),
    };

    try {
      await expect(
        materializePageRecord(
          {
            name: "001.png",
            sourcePath: archivePath,
            sourceKind: "zip-entry",
            zipEntryName: "001.png",
          },
          pagesDir,
          0,
          zipReaderCache,
          imageRuntime,
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      for (const reader of zipReaderCache.values()) {
        reader.close();
      }
    }

    expect(close).toHaveBeenCalledTimes(1);
    expect(openReadStreamPromise).not.toHaveBeenCalled();
    expect(await readdir(pagesDir)).toEqual([]);
  });
});

async function createTempDirectory(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "import-zip-reader-cancel-"));
  tempDirs.push(rootDir);
  return rootDir;
}
