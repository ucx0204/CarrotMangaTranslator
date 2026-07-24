import { describe, expect, it, vi } from "vitest";
import { hashTranslationBlocks } from "../src/shared/blockFingerprint";
import type {
  LibraryChapter,
  LibraryPageRecord,
} from "../src/shared/libraryTypes";
import type { SavePagesBlocksRequest } from "../src/shared/shareTypes";
import { createSavePagesBlocks } from "../src/main/library/libraryMutationFacade";
import {
  createSavePagesBlocksMutation,
  type SavePagesBlocksMutationRuntime,
} from "../src/main/libraryStore/libraryPageBlockMutations";

const BASE_TIME = "2026-01-01T00:00:00.000Z";
const SAVE_TIME = "2026-01-02T00:00:00.000Z";

describe("batch page block saves", () => {
  it("applies multiple pages through one lock, read, write, and work touch", async () => {
    const storage = createStorageRuntime(makeChapter());
    let lockCalls = 0;
    const savePagesBlocks = createSavePagesBlocks({
      runMutation: async (operation) => {
        lockCalls += 1;
        return operation();
      },
      savePagesBlocks: createSavePagesBlocksMutation(storage.runtime),
    });

    const saved = await savePagesBlocks(
      makeRequest([
        updateFor("page-a", "첫 페이지 수정"),
        updateFor("page-b", "둘째 페이지 수정"),
      ]),
    );

    expect(lockCalls).toBe(1);
    expect(storage.findChapterLocation).toHaveBeenCalledOnce();
    expect(storage.readChapterFile).toHaveBeenCalledOnce();
    expect(storage.writeChapterFile).toHaveBeenCalledOnce();
    expect(storage.touchWork).toHaveBeenCalledOnce();
    expect(saved.pages.map(firstTranslatedText)).toEqual([
      "첫 페이지 수정",
      "둘째 페이지 수정",
      "page-c original",
    ]);
    expect(saved.pages[0]?.updatedAt).toBe(SAVE_TIME);
    expect(saved.pages[1]?.updatedAt).toBe(SAVE_TIME);
    expect(saved.pages[2]?.updatedAt).toBe(BASE_TIME);
  });

  it("rejects a conflict on any page before writing any page", async () => {
    const chapter = makeChapter();
    const conflictedPage = requirePage(chapter, "page-b");
    conflictedPage.updatedAt = SAVE_TIME;
    conflictedPage.blocks = [makeBlock("server-side edit")];
    const before = structuredClone(chapter);
    const storage = createStorageRuntime(chapter);
    const savePagesBlocks = createSavePagesBlocksMutation(storage.runtime);

    await expect(
      savePagesBlocks(
        makeRequest([
          updateFor("page-a", "would otherwise save"),
          {
            ...updateFor("page-b", "stale renderer edit"),
            baseBlocksHash: hashTranslationBlocks([
              makeBlock("page-b original"),
            ]),
          },
        ]),
      ),
    ).rejects.toThrow(/다른 작업으로 갱신/);

    expect(storage.writeChapterFile).not.toHaveBeenCalled();
    expect(storage.touchWork).not.toHaveBeenCalled();
    expect(storage.readStoredChapter()).toEqual(before);
    expect(storage.logWarning).toHaveBeenCalledOnce();
  });

  it("does not touch work metadata when the single chapter write fails", async () => {
    const chapter = makeChapter();
    const before = structuredClone(chapter);
    const storage = createStorageRuntime(chapter);
    const failure = new Error("disk full");
    storage.writeChapterFile.mockRejectedValueOnce(failure);
    const savePagesBlocks = createSavePagesBlocksMutation(storage.runtime);

    await expect(
      savePagesBlocks(makeRequest([updateFor("page-a", "unsaved")])),
    ).rejects.toBe(failure);

    expect(storage.writeChapterFile).toHaveBeenCalledOnce();
    expect(storage.touchWork).not.toHaveBeenCalled();
    expect(storage.readStoredChapter()).toEqual(before);
  });
});

function createStorageRuntime(initialChapter: LibraryChapter) {
  let storedChapter = initialChapter;
  const findChapterLocation = vi.fn<
    SavePagesBlocksMutationRuntime["findChapterLocation"]
  >(async () => ({ workId: "work-a", chapterId: "chapter-a" }));
  const readChapterFile = vi.fn<
    SavePagesBlocksMutationRuntime["readChapterFile"]
  >(async () => storedChapter);
  const writeChapterFile = vi.fn<
    SavePagesBlocksMutationRuntime["writeChapterFile"]
  >(async (chapter) => {
    storedChapter = chapter;
  });
  const touchWork = vi.fn<SavePagesBlocksMutationRuntime["touchWork"]>(
    async () => undefined,
  );
  const logWarning = vi.fn<SavePagesBlocksMutationRuntime["logWarning"]>();
  return {
    runtime: {
      findChapterLocation,
      logWarning,
      now: () => SAVE_TIME,
      readChapterFile,
      touchWork,
      writeChapterFile,
    },
    findChapterLocation,
    logWarning,
    readChapterFile,
    readStoredChapter: () => storedChapter,
    touchWork,
    writeChapterFile,
  };
}

function makeRequest(
  pages: SavePagesBlocksRequest["pages"],
): SavePagesBlocksRequest {
  return {
    chapterId: "chapter-a",
    dirtyVersion: 7,
    saveReason: "manual",
    pages,
  };
}

function updateFor(
  pageId: string,
  translatedText: string,
): SavePagesBlocksRequest["pages"][number] {
  return {
    pageId,
    baseUpdatedAt: BASE_TIME,
    baseBlocksHash: hashTranslationBlocks([makeBlock(`${pageId} original`)]),
    blocks: [makeBlock(translatedText)],
  };
}

function makeChapter(): LibraryChapter {
  const pages = ["page-a", "page-b", "page-c"].map(makePage);
  return {
    id: "chapter-a",
    workId: "work-a",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  };
}

function makePage(id: string): LibraryPageRecord {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    width: 1000,
    height: 1000,
    blocks: [makeBlock(`${id} original`)],
    analysisStatus: "idle",
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  };
}

function makeBlock(
  translatedText: string,
): LibraryPageRecord["blocks"][number] {
  return {
    id: `block-${translatedText}`,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "source",
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 32,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#ffffff",
    backgroundColor: "transparent",
    opacity: 1,
  };
}

function requirePage(
  chapter: LibraryChapter,
  pageId: string,
): LibraryPageRecord {
  const page = chapter.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new Error(`Expected page ${pageId}`);
  }
  return page;
}

function firstTranslatedText(page: LibraryPageRecord): string | undefined {
  return page.blocks[0]?.translatedText;
}
