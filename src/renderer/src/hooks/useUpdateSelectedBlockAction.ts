import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
} from "../lib/blockFormatGeometry";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";

type UpdateSelectedBlockOptions = {
  selectedBlock: TranslationBlock | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  updateCurrentChapter: UpdateCurrentChapter;
};

/** Text edits coalesce per block; style edits coalesce separately per block. */
function resolveBlockEditMergeKey(
  blockId: string,
  patch: Partial<TranslationBlock>,
): string {
  const isTextEdit = "translatedText" in patch || "sourceText" in patch;
  return `${isTextEdit ? "text" : "style"}:${blockId}`;
}

export function useUpdateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UpdateSelectedBlockOptions): (patch: Partial<TranslationBlock>) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (patch: Partial<TranslationBlock>) => {
      if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
        return;
      }

      const mergeKey = resolveBlockEditMergeKey(selectedBlock.id, patch);
      updateCurrentChapter(
        selectedPage.id,
        (current) => ({
          ...current,
          pages: current.pages.map((page) =>
            page.id !== selectedPage.id
              ? page
              : {
                  ...page,
                  updatedAt: new Date().toISOString(),
                  blocks: page.blocks.map((block) => {
                    if (block.id !== selectedBlock.id) {
                      return block;
                    }

                    const nextType = normalizeBlockType(
                      patch.type ?? block.type,
                    );
                    const nextRenderDirection = normalizeRenderDirection(
                      patch.renderDirection ?? block.renderDirection,
                      block.renderDirection,
                    );
                    return {
                      ...block,
                      ...patch,
                      type: nextType,
                      renderDirection: nextRenderDirection,
                      rotationDeg: normalizeRotationDeg(
                        patch.rotationDeg ?? block.rotationDeg ?? 0,
                      ),
                      backgroundColor:
                        patch.backgroundColor ?? block.backgroundColor,
                      opacity: patch.opacity ?? block.opacity,
                      bbox: patch.bbox ? clampBbox(patch.bbox) : block.bbox,
                      bboxSpace: patch.bbox
                        ? "normalized_1000"
                        : block.bboxSpace,
                      renderBbox: patch.renderBbox
                        ? clampBbox(patch.renderBbox)
                        : block.renderBbox,
                      renderBboxSpace: patch.renderBbox
                        ? "normalized_1000"
                        : block.renderBboxSpace,
                    };
                  }),
                },
          ),
        }),
        { label: t("workspaceHistory.blockEdit"), mergeKey },
      );
    },
    [
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      t,
      updateCurrentChapter,
    ],
  );
}
