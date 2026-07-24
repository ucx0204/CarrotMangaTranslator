import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { InpaintingRevisionStore } from "../src/main/inpainting/inpaintingRevisionStore";
import type { InpaintingRevisionRepository } from "../src/main/inpainting/inpaintingRevisionRepository";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_A_ID = "22222222-2222-4222-8222-222222222222";
const CHAPTER_B_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_A_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_B_ID = "55555555-5555-4555-8555-555555555555";

type RepositoryHarness = {
  chapters: Map<string, ChapterSnapshot>;
  cleanupReleasedArtifacts: ReturnType<typeof vi.fn>;
  failCalls: Set<number>;
  getSaveCallCount: () => number;
  repository: InpaintingRevisionRepository;
};

describe("InpaintingRevisionStore rollback", () => {
  let harness: RepositoryHarness;

  beforeEach(() => {
    harness = createRepositoryHarness();
  });

  it("rolls back every chapter after a mid-transaction save failure", async () => {
    const { store, transactionId } = makeStore(harness.repository);
    harness.failCalls.add(2);

    await expect(
      store.applyTransaction({ transactionId, direction: "undo" }),
    ).rejects.toThrow("write failed 2");

    expect(pagePath(harness, CHAPTER_A_ID)).toBe("C:\\library\\a-after.png");
    expect(pagePath(harness, CHAPTER_B_ID)).toBe("C:\\library\\b-after.png");
    expect(store.getReference(transactionId)).toEqual({ transactionId });
    expect(harness.getSaveCallCount()).toBe(4);
  });

  it("invalidates the transaction and rereads state if rollback also fails", async () => {
    const { store, transactionId } = makeStore(harness.repository);
    harness.failCalls.add(2);
    harness.failCalls.add(3);

    const result = await store.applyTransaction({
      transactionId,
      direction: "undo",
    });

    expect(result).toMatchObject({
      transactionId,
      direction: "undo",
      invalidated: true,
      pagesChanged: 2,
    });
    expect(result.chapters).toHaveLength(2);
    expect(store.getReference(transactionId)).toBeUndefined();
    expect(harness.cleanupReleasedArtifacts).toHaveBeenCalledTimes(2);
  });
});

function createRepositoryHarness(): RepositoryHarness {
  const chapters = new Map<string, ChapterSnapshot>([
    [
      CHAPTER_A_ID,
      makeChapter(CHAPTER_A_ID, PAGE_A_ID, "C:\\library\\a-after.png"),
    ],
    [
      CHAPTER_B_ID,
      makeChapter(CHAPTER_B_ID, PAGE_B_ID, "C:\\library\\b-after.png"),
    ],
  ]);
  const failCalls = new Set<number>();
  const cleanupReleasedArtifacts = vi.fn(async () => undefined);
  let saveCallCount = 0;
  const repository: InpaintingRevisionRepository = {
    runMutation: async (operation) => operation(),
    readChapter: async (chapterId) => requireChapter(chapters, chapterId),
    readChapterAfterRollbackFailure: async (chapterId) =>
      chapters.get(chapterId),
    savePages: async (chapterId, pages) => {
      saveCallCount += 1;
      if (failCalls.has(saveCallCount)) {
        throw new Error(`write failed ${saveCallCount}`);
      }
      const chapter = requireChapter(chapters, chapterId);
      const updates = new Map(pages.map((page) => [page.id, page]));
      const saved = {
        ...chapter,
        pages: chapter.pages.map((page) => updates.get(page.id) ?? page),
      };
      chapters.set(chapterId, saved);
      return saved;
    },
    cleanupReleasedArtifacts,
    validateChangePaths: () => undefined,
  };
  return {
    chapters,
    cleanupReleasedArtifacts,
    failCalls,
    getSaveCallCount: () => saveCallCount,
    repository,
  };
}

function requireChapter(
  chapters: ReadonlyMap<string, ChapterSnapshot>,
  chapterId: string,
): ChapterSnapshot {
  const chapter = chapters.get(chapterId);
  if (!chapter) {
    throw new Error(`missing chapter: ${chapterId}`);
  }
  return chapter;
}

function makeStore(repository: InpaintingRevisionRepository): {
  store: InpaintingRevisionStore;
  transactionId: string;
} {
  const store = new InpaintingRevisionStore(repository);
  const transactionId = store.beginTransaction();
  store.addChange(transactionId, {
    chapterId: CHAPTER_A_ID,
    pageId: PAGE_A_ID,
    beforePath: "C:\\library\\a-before.png",
    afterPath: "C:\\library\\a-after.png",
  });
  store.addChange(transactionId, {
    chapterId: CHAPTER_B_ID,
    pageId: PAGE_B_ID,
    beforePath: "C:\\library\\b-before.png",
    afterPath: "C:\\library\\b-after.png",
  });
  return { store, transactionId };
}

function pagePath(
  harness: RepositoryHarness,
  chapterId: string,
): string | undefined {
  return harness.chapters.get(chapterId)?.pages[0]?.inpaintedImagePath;
}

function makeChapter(
  id: string,
  pageId: string,
  inpaintedImagePath: string,
): ChapterSnapshot {
  const page: MangaPage = {
    id: pageId,
    name: `${pageId}.png`,
    imagePath: `C:\\library\\${pageId}.png`,
    inpaintedImagePath,
    dataUrl: "data:image/png;base64,AA==",
    width: 10,
    height: 10,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    id,
    workId: WORK_ID,
    title: id,
    sourceKind: "images",
    status: "completed",
    pageOrder: [pageId],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
