import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import {
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
  offsetBlockBboxes,
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
  updateCurrentChapter: (
    pageId: string,
    updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  ) => void;
};

type BlockEditingActions = {
  applyFontToScope: (scope: "page" | "chapter", fontFamily?: string) => void;
  deleteSelectedBlock: () => void;
  duplicateSelectedBlock: () => void;
  toggleBlockInpaintExcluded: (blockId: string) => void;
  updateSelectedBlock: (patch: Partial<TranslationBlock>) => void;
};

export function useBlockEditingActions(
  options: UseBlockEditingActionsOptions,
): BlockEditingActions {
  const updateSelectedBlock = useUpdateSelectedBlockAction(options);
  const toggleBlockInpaintExcluded =
    useToggleBlockInpaintExcludedAction(options);
  const applyFontToScope = useApplyFontToScopeAction(options);
  const deleteSelectedBlock = useDeleteSelectedBlockAction(options);
  const duplicateSelectedBlock = useDuplicateSelectedBlockAction(options);

  return {
    applyFontToScope,
    deleteSelectedBlock,
    duplicateSelectedBlock,
    toggleBlockInpaintExcluded,
    updateSelectedBlock,
  };
}

function useUpdateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["updateSelectedBlock"] {
  return useCallback(
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
                    bboxSpace: patch.bbox ? "normalized_1000" : block.bboxSpace,
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
      }));
    },
    [selectedBlock, selectedPage, selectedPageEditLocked, updateCurrentChapter],
  );
}

function useToggleBlockInpaintExcludedAction({
  jobActive,
  selectedPage,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["toggleBlockInpaintExcluded"] {
  return useCallback(
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
                  block.id === blockId
                    ? { ...block, inpaintExcluded: !block.inpaintExcluded }
                    : block,
                ),
              },
        ),
      }));
    },
    [jobActive, selectedPage, updateCurrentChapter],
  );
}

function useApplyFontToScopeAction({
  currentChapter,
  currentChapterRef,
  jobActive,
  markDirty,
  pushStatus,
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["applyFontToScope"] {
  return useCallback(
    (scope: "page" | "chapter", fontFamily?: string) => {
      if (!currentChapter || !selectedBlock || selectedPageEditLocked) {
        return;
      }
      if (scope === "chapter" && jobActive) {
        pushStatus(
          "작업 중에는 전체 페이지 폰트 일괄 적용을 사용할 수 없습니다.",
        );
        return;
      }
      const targetPageIds =
        scope === "page"
          ? selectedPage
            ? [selectedPage.id]
            : []
          : currentChapter.pages.map((page) => page.id);
      if (targetPageIds.length === 0) {
        return;
      }
      const targetSet = new Set(targetPageIds);
      const stamp = new Date().toISOString();
      targetPageIds.forEach((id) => markDirty(id));
      const next = {
        ...currentChapter,
        pages: currentChapter.pages.map((page) =>
          targetSet.has(page.id)
            ? {
                ...page,
                updatedAt: stamp,
                blocks: page.blocks.map((block) => ({ ...block, fontFamily })),
              }
            : page,
        ),
      };
      currentChapterRef.current = next;
      setCurrentChapter(next);
      pushStatus(
        scope === "page"
          ? "이 페이지의 모든 블록에 폰트를 적용했습니다."
          : "이 화 전체 블록에 폰트를 적용했습니다.",
      );
    },
    [
      currentChapter,
      currentChapterRef,
      jobActive,
      markDirty,
      pushStatus,
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      setCurrentChapter,
    ],
  );
}

function useDeleteSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setSelectedBlockId,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["deleteSelectedBlock"] {
  return useCallback(() => {
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
              blocks: page.blocks.filter(
                (block) => block.id !== selectedBlock.id,
              ),
            }
          : page,
      ),
    }));
    setSelectedBlockId(null);
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    updateCurrentChapter,
  ]);
}

function useDuplicateSelectedBlockAction({
  selectedBlock,
  selectedPage,
  selectedPageEditLocked,
  setSelectedBlockId,
  updateCurrentChapter,
}: UseBlockEditingActionsOptions): BlockEditingActions["duplicateSelectedBlock"] {
  return useCallback(() => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    const copy = {
      ...offsetBlockBboxes(selectedBlock, 16, 16, {
        width: selectedPage.width,
        height: selectedPage.height,
      }),
      id: `${selectedBlock.id}-copy-${Date.now()}`,
    };
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: [...page.blocks, copy],
            }
          : page,
      ),
    }));
    setSelectedBlockId(copy.id);
  }, [
    selectedBlock,
    selectedPage,
    selectedPageEditLocked,
    setSelectedBlockId,
    updateCurrentChapter,
  ]);
}
