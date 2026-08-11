import {
  useCallback,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react";
import type { StageTool } from "../lib/stageTool";
import type { useWorkspaceBlockCreateHandlers } from "./useWorkspaceBlockCreateHandlers";
import type { useWorkspaceBlockDragHandlers } from "./useWorkspaceBlockDragHandlers";
import type { useWorkspaceBubbleLayoutHandlers } from "./useWorkspaceBubbleLayoutHandlers";
import type { useWorkspaceInpaintingPointerHandlers } from "./useWorkspaceInpaintingPointerHandlers";
import type { useWorkspacePanHandlers } from "./useWorkspacePanHandlers";
import type { useWorkspaceRegionSelectionHandlers } from "./useWorkspaceRegionSelectionHandlers";
import type { useWorkspaceMarqueeSelectionHandlers } from "./useWorkspaceMarqueeSelectionHandlers";

type StagePointerRouterDeps = {
  blockCreateHandlers: ReturnType<typeof useWorkspaceBlockCreateHandlers>;
  blockDrag: ReturnType<typeof useWorkspaceBlockDragHandlers>;
  bubbleLayoutHandlers: ReturnType<typeof useWorkspaceBubbleLayoutHandlers>;
  inpaintingHandlers: ReturnType<typeof useWorkspaceInpaintingPointerHandlers>;
  jobActive: boolean;
  panHandlers: ReturnType<typeof useWorkspacePanHandlers>;
  regionSelectionHandlers: ReturnType<
    typeof useWorkspaceRegionSelectionHandlers
  >;
  marqueeSelectionHandlers: ReturnType<
    typeof useWorkspaceMarqueeSelectionHandlers
  >;
  setSelectedBlockId: Dispatch<SetStateAction<string | null>>;
  setSelectedBlockIds: Dispatch<SetStateAction<string[]>>;
  stageTool: StageTool;
};

export function useStagePointerRouter(deps: StagePointerRouterDeps): {
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
      deps.bubbleLayoutHandlers.onBubbleLayoutPointerLeave();
    }, [deps.bubbleLayoutHandlers, inpaintingHandlers]),
  };
}

function useStagePointerDownRouter({
  blockCreateHandlers,
  bubbleLayoutHandlers,
  inpaintingHandlers,
  jobActive,
  panHandlers,
  regionSelectionHandlers,
  marqueeSelectionHandlers,
  setSelectedBlockId,
  setSelectedBlockIds,
  stageTool,
}: StagePointerRouterDeps): (event: PointerEvent) => void {
  return useCallback(
    (event: PointerEvent) => {
      if (jobActive) {
        return;
      }
      if (
        inpaintingHandlers.onPointerDown(event) ||
        regionSelectionHandlers.onRegionPointerDown(event) ||
        bubbleLayoutHandlers.onBubbleLayoutPointerDown(event) ||
        blockCreateHandlers.onBlockCreatePointerDown(event) ||
        marqueeSelectionHandlers.onMarqueePointerDown(event)
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
      bubbleLayoutHandlers,
      inpaintingHandlers,
      jobActive,
      marqueeSelectionHandlers,
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
  bubbleLayoutHandlers,
  inpaintingHandlers,
  panHandlers,
  regionSelectionHandlers,
  marqueeSelectionHandlers,
}: StagePointerRouterDeps): (event: PointerEvent) => void {
  return useCallback(
    (event: PointerEvent) => {
      if (
        inpaintingHandlers.onPointerMove(event) ||
        regionSelectionHandlers.onRegionPointerMove(event) ||
        bubbleLayoutHandlers.onBubbleLayoutPointerMove(event) ||
        blockCreateHandlers.onBlockCreatePointerMove(event) ||
        marqueeSelectionHandlers.onMarqueePointerMove(event) ||
        panHandlers.onPanPointerMove(event)
      ) {
        return;
      }
      blockDrag.onBlockPointerMove(event);
    },
    [
      blockCreateHandlers,
      blockDrag,
      bubbleLayoutHandlers,
      inpaintingHandlers,
      marqueeSelectionHandlers,
      panHandlers,
      regionSelectionHandlers,
    ],
  );
}

function useStagePointerUpRouter({
  blockCreateHandlers,
  blockDrag,
  bubbleLayoutHandlers,
  inpaintingHandlers,
  panHandlers,
  regionSelectionHandlers,
  marqueeSelectionHandlers,
}: StagePointerRouterDeps): (event: PointerEvent) => void {
  return useCallback(
    (event: PointerEvent) => {
      if (
        inpaintingHandlers.onPointerUp(event) ||
        regionSelectionHandlers.onRegionPointerUp(event) ||
        bubbleLayoutHandlers.onBubbleLayoutPointerUp(event) ||
        blockCreateHandlers.onBlockCreatePointerUp(event) ||
        marqueeSelectionHandlers.onMarqueePointerUp(event) ||
        panHandlers.onPanPointerUp(event)
      ) {
        return;
      }
      blockDrag.finishDrag(event);
    },
    [
      blockCreateHandlers,
      blockDrag,
      bubbleLayoutHandlers,
      inpaintingHandlers,
      marqueeSelectionHandlers,
      panHandlers,
      regionSelectionHandlers,
    ],
  );
}
