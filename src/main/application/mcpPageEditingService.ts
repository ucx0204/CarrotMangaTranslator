import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { createPageEditingRevision } from "../../shared/pageEditingRevision";
import { McpOperationError } from "./mcpOperationError";

type Patch = { blockId: string; translatedText: string };
type EditingPort = {
  openChapter: (chapterId: string) => Promise<ChapterSnapshot>;
  editPageBlocks: (
    chapterId: string,
    pageId: string,
    transform: (page: MangaPage) => TranslationBlock[],
    guard: () => void,
  ) => Promise<ChapterSnapshot>;
  acquire: () => { release: () => void };
  notify: (chapterId: string, pageId: string) => void;
};
/** Only translations are writable. Blocks, image layers, geometry and formatting retain their app authority. */
export class McpPageEditingService {
  constructor(private readonly port: EditingPort) {}
  async read(chapterId: string, pageId: string, offset: number, limit: number) {
    const page = pageFrom(await this.port.openChapter(chapterId), pageId);
    return {
      chapterId,
      pageId,
      width: page.width,
      height: page.height,
      revision: createPageEditingRevision(page),
      total: page.blocks.length,
      offset,
      nextOffset: offset + limit < page.blocks.length ? offset + limit : null,
      blockOrder: page.blockOrder,
      blocks: page.blocks.slice(offset, offset + limit).map((block) => ({
        id: block.id,
        type: block.type,
        sourceText: block.sourceText,
        translatedText: block.translatedText,
        bbox: block.bbox,
        renderBbox: block.renderBbox,
        bboxSpace: block.bboxSpace,
        sourceDirection: block.sourceDirection,
        renderDirection: block.renderDirection,
        textRole: block.textRole,
      })),
    };
  }
  async patch(
    chapterId: string,
    pageId: string,
    revision: string,
    patches: Patch[],
    guard: () => void,
  ) {
    guard();
    const lease = this.port.acquire();
    let previous: Patch[] = [];
    try {
      const saved = await this.port.editPageBlocks(
        chapterId,
        pageId,
        (page) => {
          guard();
          if (createPageEditingRevision(page) !== revision)
            throw new McpOperationError(
              "PAGE_CHANGED",
              "The page changed. Read its current blocks before submitting another edit.",
            );
          const ids = new Set(page.blocks.map((block) => block.id));
          if (patches.some((patch) => !ids.has(patch.blockId)))
            throw new McpOperationError(
              "BLOCK_NOT_FOUND",
              "A requested block does not exist. Nothing was saved.",
            );
          const changes = new Map(
            patches.map((patch) => [patch.blockId, patch.translatedText]),
          );
          previous = page.blocks
            .filter((block) => changes.has(block.id))
            .map((block) => ({
              blockId: block.id,
              translatedText: block.translatedText,
            }));
          return page.blocks.map((block) =>
            changes.has(block.id)
              ? { ...block, translatedText: changes.get(block.id) ?? "" }
              : block,
          );
        },
        guard,
      );
      this.port.notify(chapterId, pageId);
      return {
        chapterId,
        pageId,
        revision: createPageEditingRevision(pageFrom(saved, pageId)),
        changedBlocks: patches.length,
        undo: previous,
        note: "Saved through the app. To undo, submit these previous texts against this returned revision. No OCR or model was invoked.",
      };
    } finally {
      lease.release();
    }
  }
}
function pageFrom(chapter: ChapterSnapshot, id: string): MangaPage {
  const page = chapter.pages.find((candidate) => candidate.id === id);
  if (!page) throw new McpOperationError("BLOCK_NOT_FOUND", "Page not found.");
  return page;
}
