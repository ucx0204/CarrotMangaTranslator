import {
  useCallback,
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
} from "react";
import type { StageTool } from "../lib/stageTool";
import type { useWorkspaceBlockCreateHandlers } from "./useWorkspaceBlockCreateHandlers";
import type { useWorkspaceBlockDragHandlers } from "./useWorkspaceBlockDragHandlers";
import type { useWorkspaceInpaintingPointerHandlers } from "./useWorkspaceInpaintingPointerHandlers";
import type { useWorkspacePanHandlers } from "./useWorkspacePanHandlers";
import type { useWorkspaceRegionSelectionHandlers } from "./useWorkspaceRegionSelectionHandlers";

type StagePointerRouterDeps = {
  blockCreateHandlers: ReturnType<typeof useWorkspaceBlockCreateHandlers>;
  blockDrag: ReturnType<typeof useWorkspaceBlockDragHandlers>;
  inpaintingHandlers: ReturnType<typeof useWorkspaceInpaintingPointerHandlers>;
  jobActive: boolean;
  panHandlers: ReturnType<typeof useWorkspacePanHandlers>;
  regionSelectionHandlers: ReturnType<
    typeof useWorkspaceRegionSelectionHandlers
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
    }, [inpaintingHandlers]),
  };
}

function useStagePointerDownRouter({
  blockCreateHandlers,
  inpaintingHandlers,
  jobActive,
  panHandlers,
  regionSelectionHandlers,
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
      jobActive,
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
