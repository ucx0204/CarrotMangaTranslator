import { describe, expect, it } from "vitest";
import { InpaintingRevisionStore } from "../src/main/inpainting/inpaintingRevisionStore";
import { prepareInpaintingRevertRevision } from "../src/main/inpainting/inpaintingRevisionPreparation";
import type { InpaintingRevisionRepository } from "../src/main/inpainting/inpaintingRevisionRepository";
import { resolveChapterStatus } from "../src/main/libraryStore/chapterRecords";
import type {
  ChapterSnapshot,
  MangaPage,
  TranslationCompletionReceipt,
} from "../src/shared/libraryTypes";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const AFTER_PATH = "C:\\library\\a-after.png";

const unusedRepository: InpaintingRevisionRepository = {
  runMutation: async () => {
    throw new Error("A no-op revision must not start a repository mutation.");
  },
  readChapter: async () => {
    throw new Error("A no-op revision must not read a chapter.");
  },
  readChapterAfterRollbackFailure: async () => undefined,
  savePages: async () => {
    throw new Error("A no-op revision must not save pages.");
  },
  cleanupReleasedArtifacts: async () => {
    throw new Error("A no-op revision must not clean artifacts.");
  },
  validateChangePaths: () => {
    throw new Error("A no-op revision must not validate paths.");
  },
};

describe("InpaintingRevisionStore state", () => {
  it("treats matching image, layout, and completion receipts as a no-op", () => {
    const store = new InpaintingRevisionStore(unusedRepository);
    const transactionId = store.beginTransaction();
    const receipt = {
      workflow: "erase-original",
      status: "completed",
    } satisfies TranslationCompletionReceipt;

    expect(
      store.addChange(transactionId, {
        chapterId: "chapter-a",
        pageId: "page-a",
        beforePath: "C:\\library\\same.png",
        afterPath: "C:\\library\\same.png",
        beforeTranslationCompletion: receipt,
        afterTranslationCompletion: { ...receipt },
      }),
    ).toBe(false);
    store.discardIfEmpty(transactionId);
    expect(store.getReference(transactionId)).toBeUndefined();
  });

  it.each([
    {
      label: "pending",
      beforeReceipt: {
        workflow: "bubble-layout",
        status: "pending",
      } satisfies TranslationCompletionReceipt,
      undoChapterStatus: "partial",
    },
    {
      label: "failed",
      beforeReceipt: {
        workflow: "bubble-layout",
        status: "failed",
      } satisfies TranslationCompletionReceipt,
      undoChapterStatus: "failed",
    },
    {
      label: "missing",
      beforeReceipt: undefined,
      undoChapterStatus: "completed",
    },
  ])(
    "restores a $label completion receipt on undo and reapplies completion on redo",
    async ({ beforeReceipt, undoChapterStatus }) => {
      const harness = createMemoryRepository();
      const store = new InpaintingRevisionStore(harness.repository);
      const page = firstPage(harness.openChapter());
      const completedReceipt = {
        workflow: "bubble-layout",
        status: "completed",
      } satisfies TranslationCompletionReceipt;
      await harness.savePages([
        { ...page, translationCompletion: completedReceipt },
      ]);
      const transactionId = store.beginTransaction();

      expect(
        store.addChange(transactionId, {
          chapterId: CHAPTER_ID,
          pageId: PAGE_ID,
          beforePath: AFTER_PATH,
          afterPath: AFTER_PATH,
          beforeTranslationCompletion: beforeReceipt,
          afterTranslationCompletion: completedReceipt,
        }),
      ).toBe(true);

      await store.applyTransaction({ transactionId, direction: "undo" });
      const undone = harness.openChapter();
      expect(firstPage(undone).translationCompletion).toEqual(beforeReceipt);
      expect(undone.status).toBe(undoChapterStatus);

      await store.applyTransaction({ transactionId, direction: "redo" });
      const redone = harness.openChapter();
      expect(firstPage(redone).translationCompletion).toEqual(completedReceipt);
      expect(redone.status).toBe("completed");
    },
  );

  it("rejects undo after a completion receipt was changed independently", async () => {
    const harness = createMemoryRepository();
    const store = new InpaintingRevisionStore(harness.repository);
    const page = firstPage(harness.openChapter());
    const completedReceipt = {
      workflow: "erase-original",
      status: "completed",
    } satisfies TranslationCompletionReceipt;
    await harness.savePages([
      { ...page, translationCompletion: completedReceipt },
    ]);
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_ID,
      pageId: PAGE_ID,
      beforePath: AFTER_PATH,
      afterPath: AFTER_PATH,
      beforeTranslationCompletion: {
        workflow: "erase-original",
        status: "pending",
      },
      afterTranslationCompletion: completedReceipt,
    });
    await harness.savePages([
      {
        ...firstPage(harness.openChapter()),
        translationCompletion: {
          workflow: "erase-original",
          status: "failed",
        },
      },
    ]);

    await expect(
      store.applyTransaction({ transactionId, direction: "undo" }),
    ).rejects.toThrow(/번역 완료 상태가 다른 작업/);
    expect(store.getReference(transactionId)).toEqual({ transactionId });
    expect(firstPage(harness.openChapter()).translationCompletion).toEqual({
      workflow: "erase-original",
      status: "failed",
    });
  });

  it("records direct image revert receipt changes for exact undo and redo", async () => {
    const harness = createMemoryRepository();
    const store = new InpaintingRevisionStore(harness.repository);
    const page = firstPage(harness.openChapter());
    const completedPage = {
      ...page,
      translationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
        erasedBlockIds: ["block-a"],
      } as const,
    };
    await harness.savePages([completedPage]);
    const revision = prepareInpaintingRevertRevision({
      chapterId: CHAPTER_ID,
      page: completedPage,
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(revision.change).toMatchObject({
      beforeTranslationCompletion: {
        workflow: "bubble-layout",
        status: "completed",
        erasedBlockIds: ["block-a"],
      },
      afterTranslationCompletion: {
        workflow: "bubble-layout",
        status: "pending",
      },
    });
    const transactionId = store.beginTransaction();
    expect(store.addChange(transactionId, revision.change)).toBe(true);

    const reverted = await harness.savePages([revision.revertedPage]);
    expect(firstPage(reverted).inpaintedImagePath).toBeUndefined();
    expect(firstPage(reverted).translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "pending",
    });
    expect(reverted.status).toBe("partial");

    await store.applyTransaction({ transactionId, direction: "undo" });
    const undone = harness.openChapter();
    expect(firstPage(undone).inpaintedImagePath).toBe(AFTER_PATH);
    expect(firstPage(undone).translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "completed",
      erasedBlockIds: ["block-a"],
    });
    expect(undone.status).toBe("completed");

    await store.applyTransaction({ transactionId, direction: "redo" });
    const redone = harness.openChapter();
    expect(firstPage(redone).inpaintedImagePath).toBeUndefined();
    expect(firstPage(redone).translationCompletion).toEqual({
      workflow: "bubble-layout",
      status: "pending",
    });
    expect(redone.status).toBe("partial");
  });
});

function createMemoryRepository(): {
  repository: InpaintingRevisionRepository;
  openChapter: () => ChapterSnapshot;
  savePages: (pages: MangaPage[]) => Promise<ChapterSnapshot>;
} {
  let chapter = makeChapter();
  const savePages = async (pages: MangaPage[]): Promise<ChapterSnapshot> => {
    const updates = new Map(pages.map((page) => [page.id, page]));
    const nextPages = chapter.pages.map((current) => {
      const update = updates.get(current.id);
      if (!update) {
        return current;
      }
      const next: MangaPage = {
        ...current,
        inpaintedImagePath: update.inpaintedImagePath,
        updatedAt: update.updatedAt,
      };
      if (Object.hasOwn(update, "translationCompletion")) {
        next.translationCompletion = update.translationCompletion
          ? structuredClone(update.translationCompletion)
          : undefined;
      }
      return next;
    });
    chapter = {
      ...chapter,
      pages: nextPages,
      status: resolveChapterStatus(nextPages),
    };
    return chapter;
  };
  const repository: InpaintingRevisionRepository = {
    runMutation: async (operation) => operation(),
    readChapter: async () => chapter,
    readChapterAfterRollbackFailure: async () => chapter,
    savePages: async (_chapterId, pages) => savePages(pages),
    cleanupReleasedArtifacts: async () => undefined,
    validateChangePaths: () => undefined,
  };
  return {
    repository,
    openChapter: () => chapter,
    savePages,
  };
}

function makeChapter(): ChapterSnapshot {
  const page: MangaPage = {
    id: PAGE_ID,
    name: `${PAGE_ID}.png`,
    imagePath: "C:\\library\\source.png",
    inpaintedImagePath: AFTER_PATH,
    dataUrl: "data:image/png;base64,AA==",
    width: 64,
    height: 96,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "memory chapter",
    sourceKind: "images",
    status: "completed",
    pageOrder: [PAGE_ID],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function firstPage(chapter: ChapterSnapshot): MangaPage {
  const page = chapter.pages[0];
  if (!page) {
    throw new Error("Expected a page.");
  }
  return page;
}
