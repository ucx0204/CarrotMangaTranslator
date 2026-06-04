import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChapterSnapshot, MangaPage, TranslationBlock } from "../../../shared/types";
import {
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
  offsetBlockBboxes
} from "../../../shared/geometry";

type UseBlockEditingActionsOptions = {
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  jobActive: boolean;
  markDirty: (pageId?: string) => void;
  pushStatus: (line: string) => void;
  selectedBlock: TranslationBlock | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  updateCurrentChapter: (pageId: string, updater: (chapter: ChapterSnapshot) => ChapterSnapshot) => void;
};

export function useBlockEditingActions({
  currentChapter,
  currentChapterRef,
  jobActive,
  markDirty,
  pushStatus,
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setCurrentChapter,
  setSelectedBlockId,
  updateCurrentChapter
}: UseBlockEditingActionsOptions): {
  applyFontToScope: (scope: "page" | "chapter", fontFamily?: string) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  toggleBlockInpaintExcluded: (blockId: string) => void;
  updateSelectedBlock: (patch: Partial<TranslationBlock>) => void;
} {
  const updateSelectedBlock = useCallback(
    (patch: Partial<TranslationBlock>) => {
      if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
        return;
      }

      updateCurrentChapter(selectedPage.id, (current) => ({
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

                  const nextType = normalizeBlockType(patch.type ?? block.type);
                  const nextRenderDirection = normalizeRenderDirection(patch.renderDirection ?? block.renderDirection, block.renderDirection);
                  return {
                    ...block,
                    ...patch,
                    type: nextType,
                    renderDirection: nextRenderDirection,
                    rotationDeg: normalizeRotationDeg(patch.rotationDeg ?? block.rotationDeg ?? 0),
                    backgroundColor: patch.backgroundColor ?? block.backgroundColor,
                    opacity: patch.opacity ?? block.opacity,
                    bbox: patch.bbox ? clampBbox(patch.bbox) : block.bbox,
                    bboxSpace: patch.bbox ? "normalized_1000" : block.bboxSpace,
                    renderBbox: patch.renderBbox ? clampBbox(patch.renderBbox) : block.renderBbox,
                    renderBboxSpace: patch.renderBbox ? "normalized_1000" : block.renderBboxSpace
                  };
                })
              }
        )
      }));
    },
    [selectedBlock, selectedPage, selectedPageEditLocked, updateCurrentChapter]
  );

  const toggleBlockInpaintExcluded = useCallback(
    (blockId: string) => {
      if (!selectedPage || jobActive) {
        return;
      }
      updateCurrentChapter(selectedPage.id, (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id !== selectedPage.id
            ? page
            : {
                ...page,
                updatedAt: new Date().toISOString(),
                blocks: page.blocks.map((block) =>
                  block.id === blockId ? { ...block, inpaintExcluded: !block.inpaintExcluded } : block
                )
              }
        )
      }));
    },
    [jobActive, selectedPage, updateCurrentChapter]
  );

  const applyFontToScope = useCallback(
    (scope: "page" | "chapter", fontFamily?: string) => {
      if (!currentChapter || !selectedBlock || selectedPageEditLocked) {
        return;
      }
      const targetPageIds = scope === "page" ? (selectedPage ? [selectedPage.id] : []) : currentChapter.pages.map((page) => page.id);
      if (targetPageIds.length === 0) {
        return;
      }
      const targetSet = new Set(targetPageIds);
      const stamp = new Date().toISOString();
      const next = {
        ...currentChapter,
        pages: currentChapter.pages.map((page) =>
          targetSet.has(page.id) ? { ...page, updatedAt: stamp, blocks: page.blocks.map((block) => ({ ...block, fontFamily })) } : page
        )
      };
      currentChapterRef.current = next;
      setCurrentChapter(next);
      targetPageIds.forEach((id) => markDirty(id));
      pushStatus(scope === "page" ? "이 페이지의 모든 블록에 폰트를 적용했습니다." : "이 화 전체 블록에 폰트를 적용했습니다.");
    },
    [currentChapter, currentChapterRef, markDirty, pushStatus, selectedBlock, selectedPage, selectedPageEditLocked, setCurrentChapter]
  );

  const deleteSelectedBlock = useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: page.blocks.filter((block) => block.id !== selectedBlock.id)
            }
          : page
      )
    }));
    setSelectedBlockId(null);
  }, [selectedBlock, selectedPage, selectedPageEditLocked, setSelectedBlockId, updateCurrentChapter]);

  const duplicateSelectedBlock = useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    const copy = {
      ...offsetBlockBboxes(selectedBlock, 16, 16, { width: selectedPage.width, height: selectedPage.height }),
      id: `${selectedBlock.id}-copy-${Date.now()}`
    };
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: [...page.blocks, copy]
            }
          : page
      )
    }));
    setSelectedBlockId(copy.id);
  }, [selectedBlock, selectedPage, selectedPageEditLocked, setSelectedBlockId, updateCurrentChapter]);

  return {
    applyFontToScope,
    deleteSelectedBlock,
    duplicateSelectedBlock,
    toggleBlockInpaintExcluded,
    updateSelectedBlock
  };
}
