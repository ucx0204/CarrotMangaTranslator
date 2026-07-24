import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, LibraryIndex } from "../src/shared/libraryTypes";
import type { ChapterStoryMemory } from "../src/shared/workContextTypes";
import {
  resolvePreviousChapterStoryPages,
  type PreviousChapterContextLogger,
  type PreviousChapterContextRepository,
} from "../src/main/previousChapterContext";

describe("previous chapter cumulative context", () => {
  it("returns the latest live pages in chronological prompt-only order", async () => {
    const current = makeChapter("chapter-3", "3화", []);
    const dependencies = makeDependencies();

    const pages = await resolvePreviousChapterStoryPages(
      current,
      6,
      dependencies,
    );

    expect(pages.map((page) => page.pageId)).toEqual([
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
      "p7",
    ]);
    expect(pages.map((page) => page.pageIndex)).toEqual([
      -6, -5, -4, -3, -2, -1,
    ]);
    expect(pages[0]?.pageName).toBe("1화 · p2.png");
    expect(pages[5]?.pageName).toBe("2화 · p7.png");

    const allPages = await resolvePreviousChapterStoryPages(
      current,
      Number.POSITIVE_INFINITY,
      dependencies,
    );
    expect(allPages.map((page) => page.pageId)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
      "p7",
    ]);
    expect(dependencies.repository.openChapter).toHaveBeenCalledWith(
      "chapter-1",
    );
    expect(dependencies.repository.getChapterStoryMemory).toHaveBeenCalledWith(
      "chapter-2",
    );
    expect(dependencies.logger.warn).not.toHaveBeenCalled();
  });

  it("excludes an unreadable optional chapter and reports the failure", async () => {
    const current = makeChapter("chapter-3", "3화", []);
    const dependencies = makeDependencies();
    dependencies.repository.openChapter = vi.fn(async (chapterId) => {
      if (chapterId === "chapter-2") {
        throw new Error("chapter disk failure");
      }
      return makeChapter("chapter-1", "1화", ["p1"]);
    });

    const pages = await resolvePreviousChapterStoryPages(
      current,
      Number.POSITIVE_INFINITY,
      dependencies,
    );

    expect(pages.map((page) => page.pageId)).toEqual(["p1"]);
    expect(dependencies.logger.warn).toHaveBeenCalledOnce();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      "Previous chapter story context could not be loaded",
      expect.objectContaining({
        chapterId: "chapter-2",
        error: expect.objectContaining({ message: "chapter disk failure" }),
      }),
    );
  });
});

function makeDependencies(): {
  repository: PreviousChapterContextRepository;
  logger: PreviousChapterContextLogger;
} {
  return {
    repository: {
      listLibrary: vi.fn(async () => makeLibrary()),
      openChapter: vi.fn(async (chapterId) =>
        chapterId === "chapter-1"
          ? makeChapter("chapter-1", "1화", ["p1", "p2", "p3", "p4"])
          : makeChapter("chapter-2", "2화", ["p5", "p6", "p7"]),
      ),
      getChapterStoryMemory: vi.fn(async (chapterId) =>
        chapterId === "chapter-1"
          ? makeMemory("chapter-1", ["p4", "p3", "deleted", "p2", "p1"])
          : makeMemory("chapter-2", ["p7", "p5", "p6"]),
      ),
    },
    logger: { warn: vi.fn() },
  };
}

function makeLibrary(): LibraryIndex {
  const chapter = (id: string, title: string) => ({
    id,
    workId: "work-a",
    title,
    status: "idle" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pageCount: 0,
  });
  return {
    workOrder: ["work-a"],
    works: [
      {
        id: "work-a",
        title: "작품",
        chapterOrder: ["chapter-1", "chapter-2", "chapter-3"],
        chapters: [
          chapter("chapter-1", "1화"),
          chapter("chapter-2", "2화"),
          chapter("chapter-3", "3화"),
        ],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makeChapter(
  id: string,
  title: string,
  pageIds: string[],
): ChapterSnapshot {
  return {
    id,
    workId: "work-a",
    title,
    sourceKind: "images",
    status: "idle",
    pageOrder: pageIds,
    pages: pageIds.map((pageId) => ({
      id: pageId,
      name: `${pageId}.png`,
      imagePath: `C:\\images\\${pageId}.png`,
      dataUrl: "",
      width: 100,
      height: 100,
      blocks: [],
      analysisStatus: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeMemory(chapterId: string, pageIds: string[]): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId,
    pages: pageIds.map((pageId, pageIndex) => ({
      pageId,
      pageName: `${pageId}.png`,
      pageIndex,
      sourceDigest: pageId,
      translatedDigest: pageId,
      summary: pageId,
      visualSummary: `${pageId} 장면`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
