import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
} from "../lib/blockFormatGeometry";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import { clearAutomaticFontMatchForManualStylePatch } from "../lib/automaticFontMatchProvenance";

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
      const automaticFontRollback = isAutomaticFontRollbackPatch(patch);
      updateCurrentChapter(
        selectedPage.id,
        (current) =>
          applySelectedBlockPatch(
            current,
            selectedPage.id,
            selectedBlock.id,
            patch,
          ),
        {
          label: automaticFontRollback
            ? t("workspaceHistory.autoFontRollback")
            : t("workspaceHistory.blockEdit"),
          mergeKey: automaticFontRollback
            ? `automatic-font-rollback:${selectedBlock.id}`
            : mergeKey,
        },
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

function applySelectedBlockPatch(
  current: ChapterSnapshot,
  pageId: string,
  blockId: string,
  patch: Partial<TranslationBlock>,
): ChapterSnapshot {
  let changed = false;
  const pages = current.pages.map((page) => {
    if (page.id !== pageId) return page;
    const blocks = page.blocks.map((block) => {
      if (block.id !== blockId) return block;
      const next = normalizeBlockPatch(block, patch);
      changed ||= next !== block;
      return next;
    });
    return changed
      ? { ...page, blocks, updatedAt: new Date().toISOString() }
      : page;
  });
  return changed ? { ...current, pages } : current;
}

function normalizeBlockPatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): TranslationBlock {
  const normalizedPatch = clearAutomaticFontMatchForManualStylePatch(
    block,
    patch,
  );
  const next: TranslationBlock = {
    ...block,
    ...normalizedPatch,
    type: normalizeBlockType(normalizedPatch.type ?? block.type),
    renderDirection: normalizeRenderDirection(
      normalizedPatch.renderDirection ?? block.renderDirection,
      block.renderDirection,
    ),
    rotationDeg: normalizeRotationDeg(
      normalizedPatch.rotationDeg ?? block.rotationDeg ?? 0,
    ),
    backgroundColor: normalizedPatch.backgroundColor ?? block.backgroundColor,
    opacity: normalizedPatch.opacity ?? block.opacity,
    bbox: normalizedPatch.bbox ? clampBbox(normalizedPatch.bbox) : block.bbox,
    bboxSpace: normalizedPatch.bbox ? "normalized_1000" : block.bboxSpace,
    renderBbox: normalizedPatch.renderBbox
      ? clampBbox(normalizedPatch.renderBbox)
      : block.renderBbox,
    renderBboxSpace: normalizedPatch.renderBbox
      ? "normalized_1000"
      : block.renderBboxSpace,
  };
  return hasBlockChanged(block, next, normalizedPatch) ? next : block;
}

function isAutomaticFontRollbackPatch(
  patch: Partial<TranslationBlock>,
): boolean {
  return (
    "automaticFontMatch" in patch && patch.automaticFontMatch === undefined
  );
}

function hasBlockChanged(
  previous: TranslationBlock,
  next: TranslationBlock,
  patch: Partial<TranslationBlock>,
): boolean {
  const normalizedKeys: Array<keyof TranslationBlock> = [
    "backgroundColor",
    "bbox",
    "bboxSpace",
    "opacity",
    "renderBbox",
    "renderBboxSpace",
    "renderDirection",
    "rotationDeg",
    "type",
  ];
  const keys = new Set<keyof TranslationBlock>([
    ...(Object.keys(patch) as Array<keyof TranslationBlock>),
    ...normalizedKeys,
  ]);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) return true;
  }
  return false;
}
