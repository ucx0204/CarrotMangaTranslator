import { hashTranslationBlocks } from "../../../shared/blockFingerprint";
import { clampBbox } from "../../../shared/geometry";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { SavePageBlocksUpdate } from "../../../shared/shareTypes";
import type { ServerPageVersion } from "./chapterPersistenceTypes";

export function collectPageBlockUpdates(
  chapter: ChapterSnapshot,
  pageIds: string[],
  serverVersions: Map<string, ServerPageVersion>,
): SavePageBlocksUpdate[] {
  const pagesById = new Map(chapter.pages.map((page) => [page.id, page]));
  return pageIds.flatMap((pageId) => {
    const page = pagesById.get(pageId);
    if (!page) {
      return [];
    }
    const baseVersion = serverVersions.get(pageId);
    return [
      {
        pageId,
        baseUpdatedAt: baseVersion?.updatedAt ?? page.updatedAt,
        baseBlocksHash:
          baseVersion?.blocksHash ?? hashTranslationBlocks(page.blocks),
        blocks: serializePageBlocks(page),
        blockOrder: page.blockOrder,
      },
    ];
  });
}

function serializePageBlocks(page: MangaPage): MangaPage["blocks"] {
  return page.blocks.map((block) => ({
    ...block,
    bbox: clampBbox(block.bbox),
    renderBbox: block.renderBbox ? clampBbox(block.renderBbox) : undefined,
  }));
}
