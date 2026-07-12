import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { BlockFormatDefaults } from "../../../shared/blockFormat";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { RegionSelectionState } from "../lib/appHelpers";
import type { StageTool } from "../lib/stageTool";
import type { ChapterSnapshot, MangaPage } from "./hookLibraryTypes";
import { useWorkspaceBlockCreateHandlers } from "./useWorkspaceBlockCreateHandlers";
import { useWorkspaceBlockDragHandlers } from "./useWorkspaceBlockDragHandlers";
import { useWorkspaceInpaintingPointerHandlers } from "./useWorkspaceInpaintingPointerHandlers";
import { useWorkspacePanHandlers } from "./useWorkspacePanHandlers";
import { useWorkspaceRegionSelectionHandlers } from "./useWorkspaceRegionSelectionHandlers";
import type { RetouchPreviewState } from "./useInpaintingRetouch";
import {
  resolveNormalizedImagePoint,
  type DragHud,
  type DragMode,
} from "./workspacePointerGeometry";

export type { DragHud } from "./workspacePointerGeometry";

type UseWorkspacePointerHandlersOptions = {
  appendRetouchPoint: (
    point: { x: number; y: number },
    tool?: "brush" | "eraser" | "mask",
  ) => void;
  applyRetouchPoints: (
    tool: "brush" | "eraser",
    points: Array<{ x: number; y: number }>,
  ) => Promise<void>;
  blockFormatDefaults?: BlockFormatDefaults;
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingBrushRadius: number;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<Array<{ x: number; y: number }>>;
  inpaintingTool: InpaintingTool;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  lastInpaintingRetouchPointRef: MutableRefObject<{
    x: number;
    y: number;
  } | null>;
  pushStatus: (line: string) => void;
  regionSelection: RegionSelectionState | null;
  selectedPage: MangaPage | null;
  selectedPageEditLocked: boolean;
  selectedPageIdRef: MutableRefObject<string | null>;
  selectedPageImageDataUrl: string;
  selectedPageImagePath: string | null;
  setInpaintingPaintColor: Dispatch<SetStateAction<string>>;
  setInpaintingTool: Dispatch<SetStateAction<InpaintingTool>>;
  setPatternMaskStrokesByPage: Dispatch<
    SetStateAction<Record<string, InpaintingMaskStroke[]>>
  >;
  setRegionSelection: Dispatch<SetStateAction<RegionSelectionState | null>>;
  setRetouchCursorPoint: Dispatch<
    SetStateAction<{ x: number; y: number } | null>
  >;
  setRetouchPreview: Dispatch<SetStateAction<RetouchPreviewState | null>>;
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
  updateCurrentChapter: (
    pageId: string,
    updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
  ) => void;
  workspacePanelRef: RefObject<HTMLElement | null>;
};

type WorkspacePointerHandlers = {
  blockCreateRect: BBox | null;
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
  dragHud: DragHud | null;
};

export function useWorkspacePointerHandlers(
  options: UseWorkspacePointerHandlersOptions,
): WorkspacePointerHandlers {
  const getNormalizedImagePoint = useNormalizedImagePoint(
    options.imageRef,
    options.stageRef,
  );
  const inpaintingHandlers = useInpaintingPointerHandlers(options);
  const blockDrag = useWorkspaceBlockDragHandlers({
    currentChapter: options.currentChapter,
    imageRef: options.imageRef,
    inpaintingToolActive: options.inpaintingToolActive,
    regionSelectionActive: Boolean(options.regionSelection?.active),
    selectedPage: options.selectedPage,
    selectedPageEditLocked: options.selectedPageEditLocked,
    setSelectedBlockId: options.setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageRef: options.stageRef,
    updateCurrentChapter: options.updateCurrentChapter,
  });
  const regionSelectionHandlers = useWorkspaceRegionSelectionHandlers({
    getNormalizedImagePoint,
    jobActive: options.jobActive,
    pushStatus: options.pushStatus,
    regionSelection: options.regionSelection,
    selectedPage: options.selectedPage,
    selectedPageImageDataUrl: options.selectedPageImageDataUrl,
    setInpaintingTool: options.setInpaintingTool,
    setRegionSelection: options.setRegionSelection,
    setSelectedBlockId: options.setSelectedBlockId,
    stageRef: options.stageRef,
    translateSelectedRegion: options.translateSelectedRegion,
  });
  const blockCreateHandlers = useWorkspaceBlockCreateHandlers({
    active: options.stageTool === "block" && !options.inpaintingToolActive,
    blockFormatDefaults: options.blockFormatDefaults,
    getNormalizedImagePoint,
    pushStatus: options.pushStatus,
    selectedPage: options.selectedPage,
    selectedPageEditLocked: options.selectedPageEditLocked,
    setSelectedBlockId: options.setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageRef: options.stageRef,
    updateCurrentChapter: options.updateCurrentChapter,
  });
  const panHandlers = useWorkspacePanHandlers({
    stageRef: options.stageRef,
    workspacePanelRef: options.workspacePanelRef,
  });
  useEscapePointerCancellation(
    blockDrag.cancelActiveDrag,
    regionSelectionHandlers.cancelRegionSelection,
    blockCreateHandlers.cancelBlockCreate,
  );
  const stageHandlers = useStagePointerRouter({
    blockCreateHandlers,
    blockDrag,
    inpaintingHandlers,
    panHandlers,
    regionSelectionHandlers,
    setSelectedBlockId: options.setSelectedBlockId,
    setSelectedBlockIds: options.setSelectedBlockIds,
    stageTool: options.stageTool,
  });

  return {
    blockCreateRect: blockCreateHandlers.blockCreateRect,
    onBlockPointerDown: blockDrag.onBlockPointerDown,
    onStagePointerDown: stageHandlers.onStagePointerDown,
    onStagePointerLeave: stageHandlers.onStagePointerLeave,
    onStagePointerMove: stageHandlers.onStagePointerMove,
    onStagePointerUp: stageHandlers.onStagePointerUp,
    startRegionTranslationSelection:
      regionSelectionHandlers.startRegionTranslationSelection,
    dragHud: blockDrag.dragHud,
  };
}

function useNormalizedImagePoint(
  imageRef: RefObject<HTMLImageElement | null>,
  stageRef: RefObject<HTMLDivElement | null>,
): (event: PointerEvent) => { x: number; y: number } | null {
  return useCallback(
    (event) => {
      const stage = stageRef.current;
      if (!stage) {
        return null;
      }
      const rect =
        imageRef.current?.getBoundingClientRect() ??
        stage.getBoundingClientRect();
      return resolveNormalizedImagePoint(event, rect);
    },
    [imageRef, stageRef],
  );
}

function useInpaintingPointerHandlers(
  options: Pick<
    UseWorkspacePointerHandlersOptions,
    | "appendRetouchPoint"
    | "applyRetouchPoints"
    | "imageRef"
    | "inpaintingBrushRadius"
    | "inpaintingRetouchDrawingRef"
    | "inpaintingRetouchPointsRef"
    | "inpaintingTool"
    | "inpaintingToolActive"
    | "lastInpaintingRetouchPointRef"
    | "pushStatus"
    | "selectedPage"
    | "selectedPageIdRef"
    | "selectedPageImagePath"
    | "setInpaintingPaintColor"
    | "setPatternMaskStrokesByPage"
    | "setRetouchCursorPoint"
    | "setRetouchPreview"
    | "setSelectedBlockId"
    | "stageRef"
  >,
): ReturnType<typeof useWorkspaceInpaintingPointerHandlers> {
  return useWorkspaceInpaintingPointerHandlers(options);
}

function useEscapePointerCancellation(
  cancelActiveDrag: () => boolean,
  cancelRegionSelection: () => boolean,
  cancelBlockCreate: () => boolean,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || cancelActiveDrag() || cancelBlockCreate()) {
        return;
      }
      cancelRegionSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelActiveDrag, cancelBlockCreate, cancelRegionSelection]);
}

type StagePointerRouterDeps = {
  blockCreateHandlers: ReturnType<typeof useWorkspaceBlockCreateHandlers>;
  blockDrag: ReturnType<typeof useWorkspaceBlockDragHandlers>;
  inpaintingHandlers: ReturnType<typeof useWorkspaceInpaintingPointerHandlers>;
  panHandlers: ReturnType<typeof useWorkspacePanHandlers>;
  regionSelectionHandlers: ReturnType<
    typeof useWorkspaceRegionSelectionHandlers
  >;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageTool: StageTool;
};

function useStagePointerRouter(deps: StagePointerRouterDeps): {
  onStagePointerDown: (event: PointerEvent) => void;
  onStagePointerLeave: () => void;
  onStagePointerMove: (event: PointerEvent) => void;
  onStagePointerUp: (event: PointerEvent) => void;
} {
  const { inpaintingHandlers } = deps;
  return {
    onStagePointerDown: useStagePointerDownRouter(deps),
    onStagePointerMove: useStagePointerMoveRouter(deps),
    onStagePointerUp: useStagePointerUpRouter(deps),
    onStagePointerLeave: useCallback(() => {
      inpaintingHandlers.onPointerLeave();
    }, [inpaintingHandlers]),
  };
}

function useStagePointerDownRouter({
  blockCreateHandlers,
  inpaintingHandlers,
  panHandlers,
  regionSelectionHandlers,
  setSelectedBlockId,
  setSelectedBlockIds,
  stageTool,
}: StagePointerRouterDeps): (event: PointerEvent) => void {
  return useCallback(
    (event: PointerEvent) => {
      if (
        inpaintingHandlers.onPointerDown(event) ||
        regionSelectionHandlers.onRegionPointerDown(event) ||
        blockCreateHandlers.onBlockCreatePointerDown(event)
      ) {
        return;
      }
      if (stageTool === "hand") {
        panHandlers.startPan(event);
        return;
      }
      setSelectedBlockId(null);
      setSelectedBlockIds([]);
    },
    [
      blockCreateHandlers,
      inpaintingHandlers,
      panHandlers,
      regionSelectionHandlers,
      setSelectedBlockId,
      setSelectedBlockIds,
      stageTool,
    ],
  );
}

function useStagePointerMoveRouter({
  blockCreateHandlers,
  blockDrag,
  inpaintingHandlers,
  panHandlers,
  regionSelectionHandlers,
}: StagePointerRouterDeps): (event: PointerEvent) => void {
  return useCallback(
    (event: PointerEvent) => {
      if (
        inpaintingHandlers.onPointerMove(event) ||
        regionSelectionHandlers.onRegionPointerMove(event) ||
        blockCreateHandlers.onBlockCreatePointerMove(event) ||
        panHandlers.onPanPointerMove(event)
      ) {
        return;
      }
      blockDrag.onBlockPointerMove(event);
    },
    [
      blockCreateHandlers,
      blockDrag,
      inpaintingHandlers,
      panHandlers,
      regionSelectionHandlers,
    ],
  );
}

function useStagePointerUpRouter({
  blockCreateHandlers,
  blockDrag,
  inpaintingHandlers,
  panHandlers,
  regionSelectionHandlers,
}: StagePointerRouterDeps): (event: PointerEvent) => void {
  return useCallback(
    (event: PointerEvent) => {
      if (
        inpaintingHandlers.onPointerUp(event) ||
        regionSelectionHandlers.onRegionPointerUp(event) ||
        blockCreateHandlers.onBlockCreatePointerUp(event) ||
        panHandlers.onPanPointerUp(event)
      ) {
        return;
      }
      blockDrag.finishDrag(event);
    },
    [
      blockCreateHandlers,
      blockDrag,
      inpaintingHandlers,
      panHandlers,
      regionSelectionHandlers,
    ],
  );
}
