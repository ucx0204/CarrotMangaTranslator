import type { UpdateCurrentChapter } from "../../hooks/useCurrentChapterUpdater";
import type { TranslatedTextImportUpdate } from "../../lib/gatherText";
import { appI18n } from "../../appI18n";

/** Applies the txt-imported translations page by page as one undoable step. */
export function applyTranslatedTextUpdates(
  updates: TranslatedTextImportUpdate[],
  updateCurrentChapter: UpdateCurrentChapter,
): void {
  const byPage = new Map<string, Map<string, string>>();
  for (const update of updates) {
    const blockMap = byPage.get(update.pageId) ?? new Map<string, string>();
    blockMap.set(update.blockId, update.translatedText);
    byPage.set(update.pageId, blockMap);
  }
  const stamp = new Date().toISOString();
  for (const [pageId, blockMap] of byPage) {
    updateCurrentChapter(
      pageId,
      (chapter) => ({
        ...chapter,
        pages: chapter.pages.map((page) =>
          page.id !== pageId
            ? page
            : {
                ...page,
                updatedAt: stamp,
                blocks: page.blocks.map((block) => {
                  const translatedText = blockMap.get(block.id);
                  return translatedText === undefined
                    ? block
                    : { ...block, translatedText };
                }),
              },
        ),
      }),
      {
        label: appI18n.t("workspaceHistory.importText", { ns: "renderer" }),
        mergeKey: "gather-txt-import",
      },
    );
  }
}
