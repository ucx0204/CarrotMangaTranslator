import { hashTranslationBlocks } from "../../shared/blockFingerprint";
import { normalizeBlockType } from "../../shared/geometry";
import type {
  LibraryChapter,
  LibraryPageRecord,
} from "../../shared/libraryTypes";
import type {
  SavePageBlocksRequest,
  SavePageBlocksUpdate,
  SavePagesBlocksRequest,
} from "../../shared/shareTypes";
import { resolveChapterStatus } from "./chapterRecords";
import { hydrateChapter } from "./chapterSnapshots";
import {
  findChapterLocation,
  readChapterFile,
  touchWork,
  writeChapterFile,
} from "./libraryFiles";
import { logLibraryWarning } from "./libraryLogger";
import { resolveCompletionAfterBlockMutation } from "./translationCompletionInvalidation";

export type SavePagesBlocksMutationRuntime = {
  findChapterLocation: typeof findChapterLocation;
  logWarning: typeof logLibraryWarning;
  now: () => string;
  readChapterFile: typeof readChapterFile;
  touchWork: typeof touchWork;
  writeChapterFile: typeof writeChapterFile;
};

const productionRuntime: SavePagesBlocksMutationRuntime = {
  findChapterLocation,
  logWarning: logLibraryWarning,
  now: () => new Date().toISOString(),
  readChapterFile,
  touchWork,
  writeChapterFile,
};

export function createSavePagesBlocksMutation(
  runtime: SavePagesBlocksMutationRuntime,
): (
  request: SavePagesBlocksRequest,
) => Promise<ReturnType<typeof hydrateChapter>> {
  return async (request) => {
    assertValidPageBatch(request.pages);
    const locator = await runtime.findChapterLocation(request.chapterId);
    if (!locator) {
      throw new Error("저장할 화를 찾지 못했습니다.");
    }
    const chapter = await runtime.readChapterFile(
      locator.workId,
      locator.chapterId,
    );
    if (!chapter) {
      throw new Error("저장할 화를 찾지 못했습니다.");
    }

    const updates = resolvePageUpdates(chapter, request, runtime.logWarning);
    const now = runtime.now();
    const nextChapter = applyPageUpdates(chapter, updates, now);
    await runtime.writeChapterFile(nextChapter);
    await runtime.touchWork(locator.workId, now);
    return hydrateChapter(nextChapter);
  };
}

export const savePagesBlocksUnlocked =
  createSavePagesBlocksMutation(productionRuntime);

export function savePageBlocksUnlocked(
  request: SavePageBlocksRequest,
): Promise<ReturnType<typeof hydrateChapter>> {
  return savePagesBlocksUnlocked({
    chapterId: request.chapterId,
    dirtyVersion: request.dirtyVersion,
    saveReason: request.saveReason,
    pages: [
      {
        pageId: request.pageId,
        baseUpdatedAt: request.baseUpdatedAt,
        baseBlocksHash: request.baseBlocksHash,
        blocks: request.blocks,
      },
    ],
  });
}

function assertValidPageBatch(pages: SavePageBlocksUpdate[]): void {
  if (pages.length === 0) {
    throw new Error("저장할 페이지가 없습니다.");
  }
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) {
    throw new Error("중복된 페이지 저장 요청입니다.");
  }
}

function resolvePageUpdates(
  chapter: LibraryChapter,
  request: SavePagesBlocksRequest,
  logWarning: typeof logLibraryWarning,
): Map<string, SavePageBlocksUpdate> {
  const pagesById = new Map(chapter.pages.map((page) => [page.id, page]));
  const updates = new Map<string, SavePageBlocksUpdate>();
  for (const update of request.pages) {
    const page = pagesById.get(update.pageId);
    if (!page) {
      throw new Error("저장할 페이지를 찾지 못했습니다.");
    }
    assertPageSaveAllowed(page, update, request, logWarning);
    updates.set(update.pageId, update);
  }
  return updates;
}

function assertPageSaveAllowed(
  page: LibraryPageRecord,
  update: SavePageBlocksUpdate,
  request: SavePagesBlocksRequest,
  logWarning: typeof logLibraryWarning,
): void {
  if (!update.baseUpdatedAt || page.updatedAt === update.baseUpdatedAt) {
    return;
  }
  const currentBlocksHash = hashTranslationBlocks(page.blocks);
  if (update.baseBlocksHash && currentBlocksHash === update.baseBlocksHash) {
    return;
  }
  logWarning("Page block save conflict", {
    chapterId: request.chapterId,
    pageId: update.pageId,
    baseUpdatedAt: update.baseUpdatedAt,
    currentUpdatedAt: page.updatedAt,
    baseBlocksHash: update.baseBlocksHash,
    currentBlocksHash,
    dirtyVersion: request.dirtyVersion,
    saveReason: request.saveReason,
  });
  throw new Error(
    "페이지가 다른 작업으로 갱신되었습니다. 최신 내용을 다시 불러온 뒤 저장해 주세요.",
  );
}

function applyPageUpdates(
  chapter: LibraryChapter,
  updates: Map<string, SavePageBlocksUpdate>,
  updatedAt: string,
): LibraryChapter {
  const pages = chapter.pages.map((page) => {
    const update = updates.get(page.id);
    if (!update) return page;
    const blocks = update.blocks.map((block) => ({
      ...block,
      type: normalizeBlockType(block.type),
    }));
    return {
      ...page,
      blocks,
      translationCompletion: resolveCompletionAfterBlockMutation(
        page.translationCompletion,
        page.blocks,
        blocks,
      ),
      updatedAt,
    };
  });
  return {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt,
  };
}
