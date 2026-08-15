import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import { constrainEditableRenderBbox } from "../../../shared/editableRenderGeometry";
import {
  clampBbox,
  normalizeBlockType,
  normalizeRenderBboxTo1000,
  normalizeRenderDirection,
  normalizeRotationDeg,
  resolveEditableBlockBbox,
} from "../lib/blockFormatGeometry";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import { clearAutomaticFontMatchForManualStylePatch } from "../lib/automaticFontMatchProvenance";

type UpdateBlockOptions = {
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  updateCurrentChapter: UpdateCurrentChapter;
};

type UpdateSelectedBlockOptions = UpdateBlockOptions & {
  selectedBlock: TranslationBlock | null;
};

/** Text edits coalesce per block; style edits coalesce separately per block. */
function resolveBlockEditMergeKey(
  blockId: string,
  patch: Partial<TranslationBlock>,
): string {
  const isTextEdit = "translatedText" in patch || "sourceText" in patch;
  return `${isTextEdit ? "text" : "style"}:${blockId}`;
}

export function useUpdateBlockAction({
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UpdateBlockOptions): (
  blockId: string,
  patch: Partial<TranslationBlock>,
) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (blockId: string, patch: Partial<TranslationBlock>) => {
      if (!selectedPage || selectedPageEditLocked) {
        return;
      }

      const mergeKey = resolveBlockEditMergeKey(blockId, patch);
      const automaticFontRollback = isAutomaticFontRollbackPatch(patch);
      updateCurrentChapter(
        selectedPage.id,
        (current) =>
          applySelectedBlockPatch(current, selectedPage.id, blockId, patch),
        {
          label: automaticFontRollback
            ? t("workspaceHistory.autoFontRollback")
            : t("workspaceHistory.blockEdit"),
          mergeKey: automaticFontRollback
            ? `automatic-font-rollback:${blockId}`
            : mergeKey,
        },
      );
    },
    [selectedPage, selectedPageEditLocked, t, updateCurrentChapter],
  );
}

/** Compatibility wrapper for callers that edit only the active block. */
export function useUpdateSelectedBlockAction({
  selectedBlock,
  ...options
}: UpdateSelectedBlockOptions): (patch: Partial<TranslationBlock>) => void {
  const updateBlock = useUpdateBlockAction(options);
  return useCallback(
    (patch: Partial<TranslationBlock>) => {
      if (selectedBlock) updateBlock(selectedBlock.id, patch);
    },
    [selectedBlock, updateBlock],
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
      const next = normalizeTranslationBlockPatch(block, patch, {
        width: page.width,
        height: page.height,
      });
      changed ||= next !== block;
      return next;
    });
    return changed
      ? { ...page, blocks, updatedAt: new Date().toISOString() }
      : page;
  });
  return changed ? { ...current, pages } : current;
}

export function normalizeTranslationBlockPatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
  pageSize?: { width: number; height: number },
): TranslationBlock {
  const normalizedPatch = clearAutomaticFontMatchForManualStylePatch(
    block,
    patch,
  );
  const next = constrainPatchedVisualTransform(
    buildNormalizedTranslationBlock(block, normalizedPatch, pageSize),
    normalizedPatch,
    pageSize,
  );
  return hasBlockChanged(block, next, normalizedPatch) ? next : block;
}

function buildNormalizedTranslationBlock(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
  pageSize?: { width: number; height: number },
): TranslationBlock {
  const sourceGeometry = normalizeSourceGeometryPatch(block, patch);
  const renderGeometry = normalizeRenderGeometryPatch(block, patch, pageSize);
  return {
    ...block,
    ...patch,
    ...sourceGeometry,
    ...renderGeometry,
    type: normalizeBlockType(valueOr(patch.type, block.type)),
    renderDirection: normalizeRenderDirection(
      valueOr(patch.renderDirection, block.renderDirection),
      block.renderDirection,
    ),
    rotationDeg: normalizeRotationDeg(
      valueOr(patch.rotationDeg, valueOr(block.rotationDeg, 0)),
    ),
    backgroundColor: valueOr(patch.backgroundColor, block.backgroundColor),
    opacity: valueOr(patch.opacity, block.opacity),
  };
}

function normalizeSourceGeometryPatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
): Pick<TranslationBlock, "bbox" | "bboxSpace"> {
  if (!patch.bbox) {
    return { bbox: block.bbox, bboxSpace: block.bboxSpace };
  }
  return { bbox: clampBbox(patch.bbox), bboxSpace: "normalized_1000" };
}

function normalizeRenderGeometryPatch(
  block: TranslationBlock,
  patch: Partial<TranslationBlock>,
  pageSize?: { width: number; height: number },
): Pick<TranslationBlock, "renderBbox" | "renderBboxSpace"> {
  if (!patch.renderBbox) {
    return {
      renderBbox: block.renderBbox,
      renderBboxSpace: block.renderBboxSpace,
    };
  }
  return {
    renderBbox: constrainEditableRenderBbox(
      { ...block, ...patch },
      normalizeRenderBboxTo1000(
        patch.renderBbox,
        pageSize,
        patch.renderBboxSpace,
      ),
    ),
    renderBboxSpace: "normalized_1000",
  };
}

function constrainPatchedVisualTransform(
  next: TranslationBlock,
  patch: Partial<TranslationBlock>,
  pageSize?: { width: number; height: number },
): TranslationBlock {
  if (!changesVisualTransform(patch)) return next;
  const editableBbox = resolveEditableBlockBbox(
    next,
    pageSize,
    next.translatedText || next.sourceText || "...",
  ).bbox;
  const constrainedBbox = constrainEditableRenderBbox(next, editableBbox);
  if (areBboxesEqual(editableBbox, constrainedBbox)) return next;
  return {
    ...next,
    renderBbox: constrainedBbox,
    renderBboxSpace: "normalized_1000",
  };
}

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function changesVisualTransform(patch: Partial<TranslationBlock>): boolean {
  return (
    Object.hasOwn(patch, "rotationDeg") ||
    Object.hasOwn(patch, "perspectiveTransform") ||
    Object.hasOwn(patch, "warpTransform")
  );
}

function areBboxesEqual(
  left: TranslationBlock["bbox"],
  right: TranslationBlock["bbox"],
): boolean {
  return (
    Math.abs(left.x - right.x) < 0.0001 &&
    Math.abs(left.y - right.y) < 0.0001 &&
    Math.abs(left.w - right.w) < 0.0001 &&
    Math.abs(left.h - right.h) < 0.0001
  );
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
