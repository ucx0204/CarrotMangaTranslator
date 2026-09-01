import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { BlockFormatDefaults } from "../../../shared/blockFormat";
import type {
  InpaintingMaskStroke,
  InpaintingRetouchGeometry,
} from "../../../shared/inpaintingTypes";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { RegionSelectionState } from "../lib/appHelpers";
import type { StageTool } from "../lib/stageTool";
import type { DragMode } from "../lib/workspaceInteractionTypes";
import {
  createWorkspaceInteractionPreviewStore,
  type WorkspaceInteractionPreviewStore,
} from "../lib/workspaceInteractionPreview";
import { useWorkspaceBlockCreateHandlers } from "./useWorkspaceBlockCreateHandlers";
import { useWorkspaceBlockDragHandlers } from "./useWorkspaceBlockDragHandlers";
import { useWorkspaceBubbleLayoutHandlers } from "./useWorkspaceBubbleLayoutHandlers";
import { useEventCallback } from "./useEventCallback";
import { useStagePointerRouter } from "./useStagePointerRouter";
import { useWorkspaceInpaintingPointerHandlers } from "./useWorkspaceInpaintingPointerHandlers";
import { useWorkspacePanHandlers } from "./useWorkspacePanHandlers";
import { useWorkspaceRegionSelectionHandlers } from "./useWorkspaceRegionSelectionHandlers";
import { useWorkspaceMarqueeSelectionHandlers } from "./useWorkspaceMarqueeSelectionHandlers";
import { type PointerRect } from "./workspacePointerGeometry";
import type { UpdateCurrentChapter } from "./useCurrentChapterUpdater";

type UseWorkspacePointerHandlersOptions = {
  appendRetouchPoint: (point: {
    x: number;
    y: number;
  }) => { x: number; y: number } | null;
  applyRetouchOperation: (operation: {
    geometry: InpaintingRetouchGeometry;
    mode: "paint" | "restore";
  }) => Promise<void>;
  blockFormatDefaults?: BlockFormatDefaults;
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingPaintColor: string;
  patternMaskStrokesByPage: Record<string, InpaintingMaskStroke[]>;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<Array<{ x: number; y: number }>>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  onEscapeTool?: () => void;
  onBubbleLayoutApplied?: () => void;
  onBlockActivated?: (blockId: string) => void;
  onBlockCreated?: (blockId: string) => void;
  onSelectedBlockChange?: (blockId: string) => void;
  lastInpaintingRetouchPointRef: MutableRefObject<{
    x: number;
    y: number;
  } | null>;
  pushStatus: (line: string) => void;
  onPatternMaskChange: (
    pageId: string,
    before: InpaintingMaskStroke[],
    after: InpaintingMaskStroke[],
  ) => void;
  regionSelection: RegionSelectionState | null;
  selectedPage: MangaPage | null;
  selectedBlockId: string | null;
  selectedBlockIds?: string[];
  selectedPageEditLocked: boolean;
  selectedPageIdRef: MutableRefObject<string | null>;
  regionTranslationReady: boolean;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setInpaintingBrushRadius?: Dispatch<SetStateAction<number>>;
  setInpaintingTool: Dispatch<SetStateAction<InpaintingTool>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageRef: RefObject<HTMLDivElement | null>;
  stageTool: StageTool;
  translateSelectedRegion: (bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => Promise<void>;
  updateCurrentChapter: UpdateCurrentChapter;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

type WorkspacePointerHandlers = {
  applyBubbleLayoutDraft: () => boolean;
  cancelBubbleLayoutDraft: () => boolean;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  onBlockPointerDown: (
    event: PointerEvent,
    block: TranslationBlock,
    mode: DragMode,
  ) => void;
  onStagePointerDown: (event: PointerEvent) => void;
  onStagePointerLeave: () => void;
  onStagePointerMove: (event: PointerEvent) => void;
  onStagePointerUp: (event: PointerEvent) => void;
  startRegionTranslationSelection: () => void;
  undoBubbleLayoutPoint: () => void;
};

const NOOP = (): void => undefined;

export function useWorkspacePointerHandlers(
  options: UseWorkspacePointerHandlersOptions,
): WorkspacePointerHandlers {
  const interactionPreviewStore = useWorkspaceInteractionPreviewStore(
    options.selectedPage?.id,
  );
  const getImagePointerRect = useImagePointerRect(
    options.imageRef,
    options.stageRef,
  );
  const inpaintingHandlers = useInpaintingPointerHandlers(options);
  const blockDrag = useBlockDragHandlersForWorkspace(
    options,
    interactionPreviewStore,
  );
  const {
    blockCreateHandlers,
    bubbleLayoutHandlers,
    marqueeSelectionHandlers,
    regionSelectionHandlers,
  } = useWorkspaceDrawingHandlers(
    options,
    getImagePointerRect,
    interactionPreviewStore,
  );
  const panHandlers = useWorkspacePanHandlers({
    active: options.stageTool === "hand",
    stageRef: options.stageRef,
    workspacePanelRef: options.workspacePanelRef,
  });
  useEscapePointerCancellation(
    blockDrag.cancelActiveDrag,
    regionSelectionHandlers.cancelRegionSelection,
    marqueeSelectionHandlers.cancelMarqueeSelection,
    blockCreateHandlers.cancelBlockCreate,
    bubbleLayoutHandlers.cancelBubbleLayoutDraft,
    inpaintingHandlers.cancelDrawing,
    options.onEscapeTool ?? NOOP,
  );
  const stageHandlers = useStagePointerRouter({
    blockCreateHandlers,
    blockDrag,
    bubbleLayoutHandlers,
    inpaintingHandlers,
    jobActive: options.jobActive,
    panHandlers,
    regionSelectionHandlers,
    marqueeSelectionHandlers,
    setSelectedBlockId: options.setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageTool: options.stageTool,
  });

  return {
    applyBubbleLayoutDraft: bubbleLayoutHandlers.applyBubbleLayoutDraft,
    cancelBubbleLayoutDraft: bubbleLayoutHandlers.cancelBubbleLayoutDraft,
    interactionPreviewStore,
    onBlockPointerDown: blockDrag.onBlockPointerDown,
    onStagePointerDown: stageHandlers.onStagePointerDown,
    onStagePointerLeave: stageHandlers.onStagePointerLeave,
    onStagePointerMove: stageHandlers.onStagePointerMove,
    onStagePointerUp: stageHandlers.onStagePointerUp,
    startRegionTranslationSelection:
      regionSelectionHandlers.startRegionTranslationSelection,
    undoBubbleLayoutPoint: bubbleLayoutHandlers.undoBubbleLayoutPoint,
  };
}

function useWorkspaceDrawingHandlers(
  options: UseWorkspacePointerHandlersOptions,
  getImagePointerRect: () => PointerRect | null,
  interactionPreviewStore: WorkspaceInteractionPreviewStore,
): {
  blockCreateHandlers: ReturnType<typeof useWorkspaceBlockCreateHandlers>;
  bubbleLayoutHandlers: ReturnType<typeof useWorkspaceBubbleLayoutHandlers>;
  regionSelectionHandlers: ReturnType<
    typeof useWorkspaceRegionSelectionHandlers
  >;
  marqueeSelectionHandlers: ReturnType<
    typeof useWorkspaceMarqueeSelectionHandlers
  >;
} {
  const regionSelectionHandlers = useWorkspaceRegionSelectionHandlers({
    getImagePointerRect,
    interactionPreviewStore,
    jobActive: options.jobActive,
    pushStatus: options.pushStatus,
    regionSelection: options.regionSelection,
    selectedPage: options.selectedPage,
    regionTranslationReady: options.regionTranslationReady,
    setInpaintingTool: options.setInpaintingTool,
    setRegionSelection: options.setRegionSelection,
    setSelectedBlockId: options.setSelectedBlockId,
    stageRef: options.stageRef,
    translateSelectedRegion: options.translateSelectedRegion,
  });
  const blockCreateHandlers = useWorkspaceBlockCreateHandlers({
    active: options.stageTool === "block" && !options.inpaintingToolActive,
    blockFormatDefaults: options.blockFormatDefaults,
    getImagePointerRect,
    interactionPreviewStore,
    onBlockCreated: options.onBlockCreated,
    pushStatus: options.pushStatus,
    selectedPage: options.selectedPage,
    selectedPageEditLocked: options.selectedPageEditLocked,
    setSelectedBlockId: options.setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageRef: options.stageRef,
    updateCurrentChapter: options.updateCurrentChapter,
  });
  const marqueeSelectionHandlers = useWorkspaceMarqueeSelectionHandlers({
    active:
      options.stageTool === "select" &&
      !options.inpaintingToolActive &&
      !options.jobActive &&
      !options.selectedPageEditLocked &&
      !options.regionSelection?.active,
    getImagePointerRect,
    interactionPreviewStore,
    page: options.selectedPage,
    selectedBlockId: options.selectedBlockId,
    selectedBlockIds: options.selectedBlockIds ?? [],
    setSelectedBlockId: options.setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageRef: options.stageRef,
  });
  const bubbleLayoutHandlers = useWorkspaceBubbleLayoutHandlers({
    active: options.stageTool === "bubble" && !options.inpaintingToolActive,
    getImagePointerRect,
    interactionPreviewStore,
    onFinished: options.onBubbleLayoutApplied ?? NOOP,
    pushStatus: options.pushStatus,
    selectedBlockId: options.selectedBlockId,
    selectedPage: options.selectedPage,
    selectedPageEditLocked: options.selectedPageEditLocked,
    stageRef: options.stageRef,
    updateCurrentChapter: options.updateCurrentChapter,
  });
  return {
    blockCreateHandlers,
    bubbleLayoutHandlers,
    marqueeSelectionHandlers,
    regionSelectionHandlers,
  };
}

function useBlockDragHandlersForWorkspace(
  options: UseWorkspacePointerHandlersOptions,
  interactionPreviewStore: WorkspaceInteractionPreviewStore,
): ReturnType<typeof useWorkspaceBlockDragHandlers> {
  const setSelectedBlockId = useNotifyingBlockSelectionSetter(options);
  return useWorkspaceBlockDragHandlers({
    currentChapter: options.currentChapter,
    imageRef: options.imageRef,
    inpaintingToolActive: options.inpaintingToolActive,
    interactionPreviewStore,
    jobActive: options.jobActive,
    regionSelectionActive: Boolean(options.regionSelection?.active),
    selectedPage: options.selectedPage,
    selectedPageEditLocked: options.selectedPageEditLocked,
    setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageRef: options.stageRef,
    updateCurrentChapter: options.updateCurrentChapter,
  });
}

function useNotifyingBlockSelectionSetter(
  options: Pick<
    UseWorkspacePointerHandlersOptions,
    | "onBlockActivated"
    | "onSelectedBlockChange"
    | "selectedBlockId"
    | "setSelectedBlockId"
  >,
): (blockId: string | null) => void {
  return useCallback(
    (blockId) => {
      if (blockId !== null) {
        options.onBlockActivated?.(blockId);
        if (blockId !== options.selectedBlockId) {
          options.onSelectedBlockChange?.(blockId);
        }
      }
      options.setSelectedBlockId(blockId);
    },
    [options],
  );
}

function useWorkspaceInteractionPreviewStore(
  selectedPageId: string | undefined,
): WorkspaceInteractionPreviewStore {
  const [store] = useState(createWorkspaceInteractionPreviewStore);
  useEffect(
    () => () => {
      store.reset();
    },
    [store],
  );
  useEffect(() => {
    store.clear();
  }, [selectedPageId, store]);
  return store;
}

function useImagePointerRect(
  imageRef: RefObject<HTMLImageElement | null>,
  stageRef: RefObject<HTMLDivElement | null>,
): () => PointerRect | null {
  return useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return null;
    }
    return (
      imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect()
    );
  }, [imageRef, stageRef]);
}

function useInpaintingPointerHandlers(
  options: Pick<
    UseWorkspacePointerHandlersOptions,
    | "appendRetouchPoint"
    | "applyRetouchOperation"
    | "imageRef"
    | "inpaintingBrushRadius"
    | "inpaintingPaintColor"
    | "inpaintingRetouchDrawingRef"
    | "inpaintingRetouchPointsRef"
    | "inpaintingTool"
    | "inpaintingToolActive"
    | "jobActive"
    | "lastInpaintingRetouchPointRef"
    | "onPatternMaskChange"
    | "patternMaskStrokesByPage"
    | "pushStatus"
    | "selectedPage"
    | "selectedPageIdRef"
    | "selectedPageImagePath"
    | "setInpaintingPaintColor"
    | "setInpaintingBrushRadius"
    | "setPatternMaskStrokesByPage"
    | "setSelectedBlockId"
    | "stageRef"
  >,
): ReturnType<typeof useWorkspaceInpaintingPointerHandlers> {
  return useWorkspaceInpaintingPointerHandlers(options);
}

function useEscapePointerCancellation(
  cancelActiveDrag: () => boolean,
  cancelRegionSelection: () => boolean,
  cancelMarqueeSelection: () => boolean,
  cancelBlockCreate: () => boolean,
  cancelBubbleLayoutDraft: () => boolean,
  cancelInpaintingDrawing: () => boolean,
  onEscapeTool: () => void,
): void {
  const cancelPointerInteraction = useEventCallback(() => {
    cancelInpaintingDrawing();
    if (
      !cancelActiveDrag() &&
      !cancelBlockCreate() &&
      !cancelBubbleLayoutDraft() &&
      !cancelMarqueeSelection()
    ) {
      cancelRegionSelection();
    }
    onEscapeTool();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      cancelPointerInteraction();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelPointerInteraction]);
}
