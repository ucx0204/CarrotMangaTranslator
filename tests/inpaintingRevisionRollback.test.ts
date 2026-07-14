import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const mocks = vi.hoisted(() => ({
  chapters: new Map<string, ChapterSnapshot>(),
  failCalls: new Set<number>(),
  updateCall: 0,
  removeArtifacts: vi.fn(),
}));

vi.mock("../src/main/library/lock", () => ({
  withLibraryMutation: async <T>(operation: () => Promise<T>) => operation(),
}));
vi.mock("../src/main/libraryStore/libraryAccess", () => ({
  openChapter: async (chapterId: string) => {
    const chapter = mocks.chapters.get(chapterId);
    if (!chapter) {
      throw new Error("missing chapter");
    }
    return chapter;
  },
}));
vi.mock("../src/main/libraryStore/libraryFiles", () => ({
  WORKS_ROOT: "C:\\library\\works",
  assertChapterImagePath: (_workId: string, _chapterId: string, path: string) =>
    path,
  findChapterLocation: async (chapterId: string) => ({
    workId: WORK_ID,
    chapterId,
  }),
}));
vi.mock("../src/main/libraryStore/libraryInpaintingMutations", () => ({
  updatePagesAfterInpaintingUnlocked: async (
    chapterId: string,
    pages: MangaPage[],
  ) => {
    mocks.updateCall += 1;
    if (mocks.failCalls.has(mocks.updateCall)) {
      throw new Error(`write failed ${mocks.updateCall}`);
    }
    const chapter = mocks.chapters.get(chapterId);
    if (!chapter) {
      throw new Error("missing chapter");
    }
    const updates = new Map(pages.map((page) => [page.id, page]));
    const saved = {
      ...chapter,
      pages: chapter.pages.map((page) => updates.get(page.id) ?? page),
    };
    mocks.chapters.set(chapterId, saved);
    return saved;
  },
}));
vi.mock("../src/main/libraryStore/inpaintedArtifacts", () => ({
  removeUnreferencedInpaintedArtifacts: mocks.removeArtifacts,
}));
vi.mock("../src/main/logger", () => ({ logWarn: vi.fn() }));

import { InpaintingRevisionStore } from "../src/main/inpainting/inpaintingRevisionStore";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_A_ID = "22222222-2222-4222-8222-222222222222";
const CHAPTER_B_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_A_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_B_ID = "55555555-5555-4555-8555-555555555555";

describe("InpaintingRevisionStore rollback", () => {
  beforeEach(() => {
    mocks.chapters.clear();
    mocks.chapters.set(
      CHAPTER_A_ID,
      makeChapter(CHAPTER_A_ID, PAGE_A_ID, "C:\\library\\a-after.png"),
    );
    mocks.chapters.set(
      CHAPTER_B_ID,
      makeChapter(CHAPTER_B_ID, PAGE_B_ID, "C:\\library\\b-after.png"),
    );
    mocks.failCalls.clear();
    mocks.updateCall = 0;
    mocks.removeArtifacts.mockReset();
  });

  it("rolls back every chapter after a mid-transaction save failure", async () => {
    const { store, transactionId } = makeStore();
    mocks.failCalls.add(2);

    await expect(
      store.applyTransaction({ transactionId, direction: "undo" }),
    ).rejects.toThrow("write failed 2");
    expect(pagePath(CHAPTER_A_ID)).toBe("C:\\library\\a-after.png");
    expect(pagePath(CHAPTER_B_ID)).toBe("C:\\library\\b-after.png");
    expect(store.getReference(transactionId)).toEqual({ transactionId });
    expect(mocks.updateCall).toBe(4);
  });

  it("invalidates the transaction and rereads state if rollback also fails", async () => {
    const { store, transactionId } = makeStore();
    mocks.failCalls.add(2);
    mocks.failCalls.add(3);

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
    expect(mocks.removeArtifacts).toHaveBeenCalled();
  });
});

function makeStore(): {
  store: InpaintingRevisionStore;
  transactionId: string;
} {
  const store = new InpaintingRevisionStore();
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

function pagePath(chapterId: string): string | undefined {
  return mocks.chapters.get(chapterId)?.pages[0]?.inpaintedImagePath;
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
