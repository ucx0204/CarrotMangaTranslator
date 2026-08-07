import { describe, expect, it, vi } from "vitest";
import {
  MAX_SHARE_CHAPTERS,
  SHARE_FORMAT,
  SHARE_VERSION,
  openSharePackageSession,
  type SharePackageReaderRuntime,
} from "../src/main/libraryStore/sharePackage";
import { previewWorkShareImport } from "../src/main/libraryStore/shareWorkflow";
import type {
  ZipArchiveReader,
  ZipEntryLike,
} from "../src/main/libraryStore/zipSafety";

type FakePackageStats = {
  openCount: number;
  closeCount: number;
  inFlightChapterReads: number;
  maxInFlightChapterReads: number;
  readEntryNames: string[];
};

describe("share package session", () => {
  it("opens once, reads preview chapters serially, and closes once", async () => {
    const ids = ["chapter-a", "chapter-b", "chapter-c"];
    const fake = createFakePackage(ids);

    const preview = await previewWorkShareImport("fake.mgtshare", {
      readerRuntime: fake.runtime,
    });

    expect(fake.stats.openCount).toBe(1);
    expect(fake.stats.closeCount).toBe(1);
    expect(fake.stats.maxInFlightChapterReads).toBe(1);
    expect(preview.chapters.map((chapter) => chapter.packageChapterId)).toEqual(
      ids,
    );
    expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
    ]);
  });

  it("serializes chapter reads even when a caller uses Promise.all", async () => {
    const ids = ["chapter-a", "chapter-b", "chapter-c", "chapter-d"];
    const fake = createFakePackage(ids);
    const session = await openSharePackageSession("fake.mgtshare", {
      runtime: fake.runtime,
    });

    try {
      const chapters = await Promise.all(
        ids.map((id) => session.readChapter(id)),
      );
      expect(chapters.map((chapter) => chapter.id)).toEqual(ids);
      expect(fake.stats.maxInFlightChapterReads).toBe(1);
    } finally {
      session.close();
      session.close();
    }

    expect(fake.stats.openCount).toBe(1);
    expect(fake.stats.closeCount).toBe(1);
  });

  it("rejects duplicate manifest chapter ids before reading chapter JSON", async () => {
    const fake = createFakePackage(["chapter-a"], {
      manifestChapterIds: ["chapter-a", "chapter-a"],
    });

    await expect(
      openSharePackageSession("duplicate.mgtshare", {
        runtime: fake.runtime,
      }),
    ).rejects.toThrow(/duplicate chapter id/);

    expect(fake.stats.openCount).toBe(1);
    expect(fake.stats.closeCount).toBe(1);
    expect(chapterReadNames(fake.stats)).toEqual([]);
  });

  it("rejects 2001 manifest chapters before reading chapter JSON", async () => {
    const ids = Array.from(
      { length: MAX_SHARE_CHAPTERS + 1 },
      (_, index) => `chapter-${index + 1}`,
    );
    const fake = createFakePackage([], { manifestChapterIds: ids });

    await expect(
      openSharePackageSession("too-many.mgtshare", {
        runtime: fake.runtime,
      }),
    ).rejects.toThrow();

    expect(fake.stats.openCount).toBe(1);
    expect(fake.stats.closeCount).toBe(1);
    expect(chapterReadNames(fake.stats)).toEqual([]);
  });

  it("stops at the first malformed chapter and returns no partial preview", async () => {
    const ids = ["chapter-a", "chapter-b", "chapter-c", "chapter-d"];
    const fake = createFakePackage(ids, {
      chapterBuffers: new Map([["chapter-c", Buffer.from("{")]]),
    });

    await expect(
      previewWorkShareImport("malformed.mgtshare", {
        readerRuntime: fake.runtime,
      }),
    ).rejects.toThrow(/chapter\.json/);

    expect(chapterReadNames(fake.stats)).toEqual([
      "chapters/chapter-a/chapter.json",
      "chapters/chapter-b/chapter.json",
      "chapters/chapter-c/chapter.json",
    ]);
    expect(fake.stats.closeCount).toBe(1);
  });

  it("rejects duplicate page block ids before any image entry can be read", async () => {
    const fake = createFakePackage(["chapter-a"], {
      chapterBuffers: new Map([
        ["chapter-a", makeDuplicateBlockChapterBuffer("chapter-a")],
      ]),
    });

    await expect(
      previewWorkShareImport("duplicate-blocks.mgtshare", {
        readerRuntime: fake.runtime,
      }),
    ).rejects.toThrow(/블록 ID|block ID/i);

    expect(fake.stats.openCount).toBe(1);
    expect(fake.stats.closeCount).toBe(1);
    expect(chapterReadNames(fake.stats)).toEqual([
      "chapters/chapter-a/chapter.json",
    ]);
    expect(
      fake.stats.readEntryNames.some((name) => name.includes("/pages/")),
    ).toBe(false);
  });

  it("closes the reader when abort happens immediately after open", async () => {
    const controller = new AbortController();
    const fake = createFakePackage(["chapter-a"], {
      onOpen: () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
      },
    });

    await expect(
      openSharePackageSession("aborted.mgtshare", {
        signal: controller.signal,
        runtime: fake.runtime,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fake.stats.openCount).toBe(1);
    expect(fake.stats.closeCount).toBe(1);
    expect(fake.stats.readEntryNames).toEqual([]);
  });
});

function createFakePackage(
  chapterIds: string[],
  options: {
    manifestChapterIds?: string[];
    chapterBuffers?: Map<string, Buffer>;
    onOpen?: () => void;
  } = {},
): {
  runtime: SharePackageReaderRuntime;
  stats: FakePackageStats;
} {
  const manifestChapterIds = options.manifestChapterIds ?? chapterIds;
  const buffers = new Map<string, Buffer>();
  buffers.set(
    "manifest.json",
    jsonBuffer({
      format: SHARE_FORMAT,
      version: SHARE_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      work: {
        id: "fake-work",
        title: "Fake Work",
      },
      chapterOrder: manifestChapterIds,
    }),
  );
  chapterIds.forEach((id, index) => {
    buffers.set(
      `chapters/${id}/chapter.json`,
      options.chapterBuffers?.get(id) ?? makeChapterBuffer(id, index),
    );
  });

  const entries = Array.from(buffers, ([entryName, buffer]) =>
    makeEntry(entryName, buffer),
  );
  const entryMap = new Map(entries.map((entry) => [entry.entryName, entry]));
  const stats: FakePackageStats = {
    openCount: 0,
    closeCount: 0,
    inFlightChapterReads: 0,
    maxInFlightChapterReads: 0,
    readEntryNames: [],
  };
  const reader: ZipArchiveReader = {
    entries,
    entryMap,
    readEntry: vi.fn(async (entryName) => {
      stats.readEntryNames.push(entryName);
      const isChapter = entryName.endsWith("/chapter.json");
      if (isChapter) {
        stats.inFlightChapterReads += 1;
        stats.maxInFlightChapterReads = Math.max(
          stats.maxInFlightChapterReads,
          stats.inFlightChapterReads,
        );
        await Promise.resolve();
      }
      try {
        const value = buffers.get(entryName);
        if (!value) {
          throw new Error(`missing fake entry: ${entryName}`);
        }
        return value;
      } finally {
        if (isChapter) {
          stats.inFlightChapterReads -= 1;
        }
      }
    }),
    close: vi.fn(() => {
      stats.closeCount += 1;
    }),
  };
  const runtime: SharePackageReaderRuntime = {
    openArchive: vi.fn(async () => {
      stats.openCount += 1;
      options.onOpen?.();
      return reader;
    }),
  };
  return { runtime, stats };
}

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

function makeChapterBuffer(id: string, index: number): Buffer {
  return jsonBuffer({
    id,
    workId: "fake-work",
    title: `Chapter ${index + 1}`,
    sourceKind: "folder",
    status: "idle",
    pageOrder: [],
    pages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function makeDuplicateBlockChapterBuffer(id: string): Buffer {
  const block = {
    id: "duplicate",
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 16,
    lineHeight: 1.2,
    textAlign: "left",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
  return jsonBuffer({
    id,
    workId: "fake-work",
    title: "Duplicate Blocks",
    sourceKind: "folder",
    status: "idle",
    pageOrder: ["page-a"],
    pages: [
      {
        id: "page-a",
        name: "page.png",
        imagePath: `chapters/${id}/pages/page.png`,
        width: 100,
        height: 100,
        blocks: [block, { ...block }],
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function chapterReadNames(stats: FakePackageStats): string[] {
  return stats.readEntryNames.filter((name) => name.endsWith("/chapter.json"));
}
