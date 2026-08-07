import { expect, it, vi } from "vitest";
import {
  MAX_SHARE_CHAPTERS,
  SHARE_FORMAT,
  SHARE_VERSION,
  openSharePackageSession,
  type SharePackageReaderRuntime,
} from "../src/main/libraryStore/sharePackage";
import type {
  ZipArchiveReader,
  ZipEntryLike,
} from "../src/main/libraryStore/zipSafety";

it("reads only explicitly requested chapter JSON from a 2000 chapter package", async () => {
  const chapterIds = Array.from(
    { length: MAX_SHARE_CHAPTERS },
    (_, index) => `chapter-${String(index + 1).padStart(4, "0")}`,
  );
  const buffers = new Map<string, Buffer>();
  buffers.set(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        format: SHARE_FORMAT,
        version: SHARE_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        work: {
          id: "package-work",
          title: "Package Work",
        },
        chapterOrder: chapterIds,
      }),
    ),
  );
  chapterIds.forEach((chapterId) => {
    buffers.set(
      `chapters/${chapterId}/chapter.json`,
      Buffer.from(
        JSON.stringify({
          id: chapterId,
          workId: "package-work",
          title: chapterId,
          sourceKind: "folder",
          status: "idle",
          pageOrder: [],
          pages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
  });
  const entries = Array.from(buffers, ([entryName, buffer]) =>
    makeEntry(entryName, buffer),
  );
  const chapterReadNames: string[] = [];
  const close = vi.fn();
  const reader: ZipArchiveReader = {
    entries,
    entryMap: new Map(entries.map((entry) => [entry.entryName, entry])),
    readEntry: vi.fn(async (entryName) => {
      if (entryName.endsWith("/chapter.json")) {
        chapterReadNames.push(entryName);
      }
      const buffer = buffers.get(entryName);
      if (!buffer) {
        throw new Error(`missing fake entry: ${entryName}`);
      }
      return buffer;
    }),
    close,
  };
  const runtime: SharePackageReaderRuntime = {
    openArchive: vi.fn(async () => reader),
  };

  const session = await openSharePackageSession("fake-2000.mgtshare", {
    runtime,
  });
  try {
    expect(chapterReadNames).toEqual([]);
    await session.readChapter("chapter-0017");
    await session.readChapter("chapter-1999");
    expect(chapterReadNames).toEqual([
      "chapters/chapter-0017/chapter.json",
      "chapters/chapter-1999/chapter.json",
    ]);
  } finally {
    session.close();
  }

  expect(runtime.openArchive).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

function makeEntry(entryName: string, buffer: Buffer): ZipEntryLike {
  return {
    entryName,
    isDirectory: false,
    header: {
      size: buffer.byteLength,
      compressedSize: Math.max(1, buffer.byteLength),
    },
  };
}
