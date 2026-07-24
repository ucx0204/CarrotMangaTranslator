import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InpaintingRevisionStore,
  type InpaintingRevisionDiagnostics,
} from "../src/main/inpainting/inpaintingRevisionStore";
import type { InpaintingRevisionRepository } from "../src/main/inpainting/inpaintingRevisionRepository";

const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const BEFORE_PATH = "C:\\library\\before.png";
const AFTER_PATH = "C:\\library\\after.png";

describe("InpaintingRevisionStore cleanup retry queue", () => {
  let cleanupReleasedArtifacts: ReturnType<
    typeof vi.fn<InpaintingRevisionRepository["cleanupReleasedArtifacts"]>
  >;
  let warn: ReturnType<typeof vi.fn<InpaintingRevisionDiagnostics["warn"]>>;
  let repository: InpaintingRevisionRepository;
  let diagnostics: InpaintingRevisionDiagnostics;

  beforeEach(() => {
    cleanupReleasedArtifacts =
      vi.fn<InpaintingRevisionRepository["cleanupReleasedArtifacts"]>();
    warn = vi.fn<InpaintingRevisionDiagnostics["warn"]>();
    repository = {
      runMutation: async (operation) => operation(),
      readChapter: async () => {
        throw new Error("cleanup must not read a chapter directly");
      },
      readChapterAfterRollbackFailure: async () => undefined,
      savePages: async () => {
        throw new Error("cleanup must not save pages");
      },
      cleanupReleasedArtifacts,
      validateChangePaths: () => undefined,
    };
    diagnostics = { warn };
  });

  it("retries a released transaction cleanup on the next awaited release", async () => {
    cleanupReleasedArtifacts
      .mockRejectedValueOnce(new Error("file is temporarily locked"))
      .mockResolvedValueOnce(undefined);
    const store = new InpaintingRevisionStore(repository, diagnostics);
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_ID,
      pageId: PAGE_ID,
      beforePath: BEFORE_PATH,
      afterPath: AFTER_PATH,
    });

    await expect(store.releaseTransactions([transactionId])).resolves.toBe(1);
    expect(cleanupReleasedArtifacts).toHaveBeenCalledTimes(1);
    expect(cleanupReleasedArtifacts).toHaveBeenCalledWith({
      chapterId: CHAPTER_ID,
      changes: [
        {
          chapterId: CHAPTER_ID,
          pageId: PAGE_ID,
          beforePath: BEFORE_PATH,
          afterPath: AFTER_PATH,
        },
      ],
      retainedPaths: [],
    });
    expect(warn).toHaveBeenCalledWith(
      "Failed to clean released inpainting history artifacts",
      expect.objectContaining({
        chapterId: CHAPTER_ID,
        error: expect.any(Error),
      }),
    );

    await expect(store.releaseAll()).resolves.toBe(0);
    expect(cleanupReleasedArtifacts).toHaveBeenCalledTimes(2);

    await store.releaseAll();
    expect(cleanupReleasedArtifacts).toHaveBeenCalledTimes(2);
  });

  it("retries the whole cleanup batch when the mutation boundary fails", async () => {
    let mutationAttempts = 0;
    repository.runMutation = async (operation) => {
      mutationAttempts += 1;
      if (mutationAttempts === 1) {
        throw new Error("lock unavailable");
      }
      return operation();
    };
    cleanupReleasedArtifacts.mockResolvedValue(undefined);
    const store = new InpaintingRevisionStore(repository, diagnostics);
    const transactionId = store.beginTransaction();
    store.addChange(transactionId, {
      chapterId: CHAPTER_ID,
      pageId: PAGE_ID,
      beforePath: BEFORE_PATH,
      afterPath: AFTER_PATH,
    });

    await store.releaseTransactions([transactionId]);
    expect(cleanupReleasedArtifacts).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Failed to acquire library lock for inpainting history cleanup",
      expect.objectContaining({ error: expect.any(Error) }),
    );

    await store.releaseAll();
    expect(cleanupReleasedArtifacts).toHaveBeenCalledTimes(1);
    expect(mutationAttempts).toBe(2);
  });
});
