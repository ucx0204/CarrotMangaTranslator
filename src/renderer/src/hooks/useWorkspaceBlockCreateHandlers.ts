import {
  useCallback,
  useRef,
  type Dispatch,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import {
  applyFormatDefaultsToBlock,
  type BlockFormatDefaults,
} from "../../../shared/blockFormat";
import { resolveBlockVisualStyle } from "../../../shared/blockVisuals";
import { estimateFontSizePx } from "../../../shared/geometry";
import type { MangaPage } from "../../../shared/libraryTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import { regionSelectionToBbox } from "../lib/appHelpers";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  resolveNormalizedImagePoint,
  type PointerRect,
} from "./workspacePointerGeometry";

type UseWorkspaceBlockCreateHandlersOptions = {
  active: boolean;
  blockFormatDefaults?: BlockFormatDefaults;
  getImagePointerRect: () => PointerRect | null;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  onBlockCreated?: (blockId: string) => void;
  pushStatus: (line: string) => void;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  setSelectedBlockId: (blockId: string | null) => void;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  updateCurrentChapter: UpdateCurrentChapter;
};

type BlockCreateDraft = {
  current: { x: number; y: number };
  pointerId: number;
  pointerRect: PointerRect;
  start: { x: number; y: number };
};

type BlockCreateHandlers = {
  cancelBlockCreate: () => boolean;
  onBlockCreatePointerDown: (event: PointerEvent) => boolean;
  onBlockCreatePointerMove: (event: PointerEvent) => boolean;
  onBlockCreatePointerUp: (event: PointerEvent) => boolean;
};

/**
 * Block tool: pointer bursts update only the isolated preview store. The
 * chapter, history and persistence layers receive one semantic edit on release.
 */
export function useWorkspaceBlockCreateHandlers(
  options: UseWorkspaceBlockCreateHandlersOptions,
): BlockCreateHandlers {
  const { t } = useTranslation("renderer");
  const draftRef = useRef<BlockCreateDraft | null>(null);
  const createBlockFromBbox = useCreateBlockFromBbox(options);
  const { interactionPreviewStore, pushStatus, stageRef } = options;
  const onBlockCreatePointerDown = useBlockCreatePointerDown(options, draftRef);

  const onBlockCreatePointerMove = useCallback(
    (event: PointerEvent) => {
      const draft = draftRef.current;
      if (!draft) {
        return false;
      }
      const point = resolveNormalizedImagePoint(event, draft.pointerRect);
      if (point) {
        draft.current = point;
        interactionPreviewStore.queue({
          blockCreateRect: draftToBbox(draft),
        });
      }
      return true;
    },
    [interactionPreviewStore],
  );

  const onBlockCreatePointerUp = useCallback(
    (event: PointerEvent) => {
      const draft = draftRef.current;
      if (!draft) {
        return false;
      }
      releasePointerCaptureSafely(stageRef.current, draft.pointerId);
      draftRef.current = null;
      interactionPreviewStore.set({ blockCreateRect: null });
      if (event.type === "pointercancel") {
        return true;
      }
      const finalPoint = resolveNormalizedImagePoint(event, draft.pointerRect);
      if (finalPoint) draft.current = finalPoint;
      const bbox = draftToBbox(draft);
      if (!isUsableRegionBbox(bbox, 10)) {
        pushStatus(t("blockCreate.tooSmall"));
        return true;
      }
      createBlockFromBbox(bbox);
      return true;
    },
    [createBlockFromBbox, interactionPreviewStore, pushStatus, stageRef, t],
  );

  const cancelBlockCreate = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) {
      return false;
    }
    releasePointerCaptureSafely(stageRef.current, draft.pointerId);
    draftRef.current = null;
    interactionPreviewStore.set({ blockCreateRect: null });
    return true;
  }, [interactionPreviewStore, stageRef]);

  return {
    cancelBlockCreate,
    onBlockCreatePointerDown,
    onBlockCreatePointerMove,
    onBlockCreatePointerUp,
  };
}

function useBlockCreatePointerDown(
  {
    active,
    getImagePointerRect,
    interactionPreviewStore,
    selectedPage,
    selectedPageEditLocked,
    stageRef,
  }: UseWorkspaceBlockCreateHandlersOptions,
  draftRef: RefObject<BlockCreateDraft | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event: PointerEvent) => {
      if (!active) {
        return false;
      }
      if (!selectedPage || selectedPageEditLocked) {
        return true;
      }
      const pointerRect = getImagePointerRect();
      const point = pointerRect
        ? resolveNormalizedImagePoint(event, pointerRect)
        : null;
      if (!point || !pointerRect || !stageRef.current || event.button !== 0) {
        return true;
      }
      event.preventDefault();
      const draft = {
        current: point,
        pointerId: event.pointerId,
        pointerRect,
        start: point,
      };
      draftRef.current = draft;
      interactionPreviewStore.set({
        blockCreateRect: draftToBbox(draft),
      });
      capturePointerSafely(stageRef.current, event.pointerId);
      return true;
    },
    [
      active,
      draftRef,
      getImagePointerRect,
      interactionPreviewStore,
      selectedPage,
      selectedPageEditLocked,
      stageRef,
    ],
  );
}

function draftToBbox(draft: Pick<BlockCreateDraft, "current" | "start">): BBox {
  return regionSelectionToBbox({
    active: true,
    dragging: true,
    start: draft.start,
    current: draft.current,
  });
}

function useCreateBlockFromBbox({
  blockFormatDefaults,
  onBlockCreated,
  pushStatus,
  selectedPage,
  setSelectedBlockId,
  setSelectedBlockIds,
  updateCurrentChapter,
}: UseWorkspaceBlockCreateHandlersOptions): (bbox: BBox) => void {
  const { t } = useTranslation("renderer");
  return useCallback(
    (bbox: BBox) => {
      if (!selectedPage) {
        return;
      }
      const block = buildManualBlock(selectedPage, bbox, blockFormatDefaults);
      updateCurrentChapter(
        selectedPage.id,
        (chapter) => ({
          ...chapter,
          pages: chapter.pages.map((page) =>
            page.id !== selectedPage.id
              ? page
              : {
                  ...page,
                  updatedAt: new Date().toISOString(),
                  blocks: [...page.blocks, block],
                },
          ),
        }),
        {
          label: t("workspaceHistory.createBlock"),
          selectionAfter: {
            selectedPageId: selectedPage.id,
            selectedBlockId: block.id,
            selectedBlockIds: [block.id],
          },
        },
      );
      setSelectedBlockId(block.id);
      setSelectedBlockIds([block.id]);
      onBlockCreated?.(block.id);
      pushStatus(t("blockCreate.added"));
    },
    [
      blockFormatDefaults,
      onBlockCreated,
      pushStatus,
      selectedPage,
      setSelectedBlockId,
      setSelectedBlockIds,
      updateCurrentChapter,
      t,
    ],
  );
}

function buildManualBlock(
  page: MangaPage,
  bbox: BBox,
  formatDefaults: BlockFormatDefaults | undefined,
): TranslationBlock {
  const visualStyle = resolveBlockVisualStyle("nonsolid");
  return applyFormatDefaultsToBlock(
    {
      id: `${page.id}-manual-${Date.now()}`,
      type: "nonsolid",
      bbox,
      bboxSpace: "normalized_1000",
      sourceText: "",
      translatedText: "",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      rotationDeg: 0,
      fontSizePx: estimateFontSizePx("...", bbox, {
        width: page.width,
        height: page.height,
      }),
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      outlineColor: "#ffffff",
      backgroundColor: visualStyle.backgroundColor,
      opacity: visualStyle.defaultOpacity,
      autoFitText: true,
    },
    formatDefaults,
  );
}
