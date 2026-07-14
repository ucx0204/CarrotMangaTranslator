import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

const mocks = vi.hoisted(() => ({
  removeArtifacts: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/main/library/lock", () => ({
  withLibraryMutation: async <T>(operation: () => Promise<T>) => operation(),
}));
vi.mock("../src/main/libraryStore/libraryAccess", () => ({
  openChapter: async () => CHAPTER,
}));
vi.mock("../src/main/libraryStore/libraryFiles", () => ({
  WORKS_ROOT: "C:\\library\\works",
  assertChapterImagePath: (_workId: string, _chapterId: string, path: string) =>
    path,
  findChapterLocation: async () => ({
    workId: WORK_ID,
    chapterId: CHAPTER_ID,
  }),
}));
vi.mock("../src/main/libraryStore/libraryInpaintingMutations", () => ({
  updatePagesAfterInpaintingUnlocked: vi.fn(),
}));
vi.mock("../src/main/libraryStore/inpaintedArtifacts", () => ({
  removeUnreferencedInpaintedArtifacts: mocks.removeArtifacts,
}));
vi.mock("../src/main/inpainting/inpaintingRuntimeLogger", () => ({
  logInpaintingRuntimeWarn: mocks.warn,
}));

import { InpaintingRevisionStore } from "../src/main/inpainting/inpaintingRevisionStore";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const BEFORE_PATH = `C:\\library\\works\\${WORK_ID}\\chapters\\${CHAPTER_ID}\\inpainted\\before.png`;
const AFTER_PATH = `C:\\library\\works\\${WORK_ID}\\chapters\\${CHAPTER_ID}\\inpainted\\after.png`;

const CHAPTER: ChapterSnapshot = {
  id: CHAPTER_ID,
  workId: WORK_ID,
  title: "cleanup retry",
  sourceKind: "images",
  status: "completed",
  pageOrder: [PAGE_ID],
  pages: [
    {
      id: PAGE_ID,
      name: "page.png",
      imagePath: `C:\\library\\works\\${WORK_ID}\\chapters\\${CHAPTER_ID}\\pages\\page.png`,
      inpaintedImagePath: AFTER_PATH,
      dataUrl: "",
      width: 10,
      height: 10,
      blocks: [],
      analysisStatus: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("InpaintingRevisionStore cleanup retry queue", () => {
  beforeEach(() => {
    mocks.removeArtifacts.mockReset();
    mocks.warn.mockReset();
  });

  it("retries a released transaction cleanup on the next awaited release", async () => {
    mocks.removeArtifacts
      .mockRejectedValueOnce(new Error("file is temporarily locked"))
      .mockResolvedValueOnce(undefined);
    const store = new InpaintingRevisionStore();
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_ID,
      pageId: PAGE_ID,
      beforePath: BEFORE_PATH,
      afterPath: AFTER_PATH,
    });

    await expect(store.releaseTransactions([transactionId])).resolves.toBe(1);
    expect(mocks.removeArtifacts).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);

    await expect(store.releaseAll()).resolves.toBe(0);
    expect(mocks.removeArtifacts).toHaveBeenCalledTimes(2);

    await store.releaseAll();
    expect(mocks.removeArtifacts).toHaveBeenCalledTimes(2);
  });
});
