import { useCallback, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { BBox } from "../../../shared/textTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import type { MangaPage } from "./hookLibraryTypes";
import {
  regionSelectionToBbox,
  type RegionSelectionState,
} from "../lib/appHelpers";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";

type UseWorkspaceRegionSelectionHandlersOptions = {
  getNormalizedImagePoint: (
    event: PointerEvent,
  ) => { x: number; y: number } | null;
  jobActive: boolean;
  pushStatus: (line: string) => void;
  regionSelection: RegionSelectionState | null;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  setInpaintingTool: (tool: InpaintingTool) => void;
  setRegionSelection: (
    updater:
      | RegionSelectionState
      | null
      | ((current: RegionSelectionState | null) => RegionSelectionState | null),
  ) => void;
  setSelectedBlockId: (blockId: string | null) => void;
  stageRef: RefObject<HTMLDivElement | null>;
  translateSelectedRegion: (bbox: BBox) => Promise<void>;
};

export function useWorkspaceRegionSelectionHandlers(
  options: UseWorkspaceRegionSelectionHandlersOptions,
): {
  cancelRegionSelection: () => boolean;
  onRegionPointerDown: (event: PointerEvent) => boolean;
  onRegionPointerMove: (event: PointerEvent) => boolean;
  onRegionPointerUp: (event: PointerEvent) => boolean;
  startRegionTranslationSelection: () => void;
} {
  const cancelRegionSelection = useCancelRegionSelection(options);
  const startRegionTranslationSelection = useStartRegionTranslationSelection(
    options,
    cancelRegionSelection,
  );
  const onRegionPointerDown = useRegionPointerDown(options);
  const onRegionPointerMove = useRegionPointerMove(options);
  const onRegionPointerUp = useRegionPointerUp(options);

  return {
    cancelRegionSelection,
    onRegionPointerDown,
    onRegionPointerMove,
    onRegionPointerUp,
    startRegionTranslationSelection,
  };
}

function useCancelRegionSelection({
  pushStatus,
  regionSelection,
  setRegionSelection,
}: UseWorkspaceRegionSelectionHandlersOptions): () => boolean {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!regionSelection?.active) {
      return false;
    }
    setRegionSelection(null);
    pushStatus(t("regionTranslation.cancelledSelection"));
    return true;
  }, [pushStatus, regionSelection?.active, setRegionSelection, t]);
}

function useStartRegionTranslationSelection(
  {
    jobActive,
    pushStatus,
    selectedPage,
    selectedPageImageDataUrl,
    setInpaintingTool,
    setRegionSelection,
    setSelectedBlockId,
  }: UseWorkspaceRegionSelectionHandlersOptions,
  cancelRegionSelection: () => boolean,
): () => void {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!selectedPage || !selectedPageImageDataUrl || jobActive) {
      return;
    }
    if (cancelRegionSelection()) {
      return;
    }
    setSelectedBlockId(null);
    setInpaintingTool("none");
    setRegionSelection({
      active: true,
      dragging: false,
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 },
    });
    pushStatus(t("regionTranslation.dragPrompt"));
  }, [
    cancelRegionSelection,
    jobActive,
    pushStatus,
    selectedPage,
    selectedPageImageDataUrl,
    setInpaintingTool,
    setRegionSelection,
    setSelectedBlockId,
    t,
  ]);
}

function useRegionPointerDown({
  getNormalizedImagePoint,
  regionSelection,
  setRegionSelection,
  setSelectedBlockId,
  stageRef,
}: UseWorkspaceRegionSelectionHandlersOptions): (
  event: PointerEvent,
) => boolean {
  return useCallback(
    (event) => {
      if (!regionSelection?.active) {
        return false;
      }
      const point = getNormalizedImagePoint(event);
      if (!point || !stageRef.current) {
        return true;
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(null);
      setRegionSelection({
        active: true,
        dragging: true,
        start: point,
        current: point,
      });
      capturePointerSafely(stageRef.current, event.pointerId);
      return true;
    },
    [
      getNormalizedImagePoint,
      regionSelection?.active,
      setRegionSelection,
      setSelectedBlockId,
      stageRef,
    ],
  );
}

function useRegionPointerMove({
  getNormalizedImagePoint,
  regionSelection,
  setRegionSelection,
}: UseWorkspaceRegionSelectionHandlersOptions): (
  event: PointerEvent,
) => boolean {
  return useCallback(
    (event) => {
      if (!regionSelection?.active || !regionSelection.dragging) {
        return false;
      }
      const point = getNormalizedImagePoint(event);
      if (point) {
        setRegionSelection((current) =>
          current?.active ? { ...current, current: point } : current,
        );
      }
      return true;
    },
    [getNormalizedImagePoint, regionSelection, setRegionSelection],
  );
}

function useRegionPointerUp({
  getNormalizedImagePoint,
  pushStatus,
  regionSelection,
  setRegionSelection,
  stageRef,
  translateSelectedRegion,
}: UseWorkspaceRegionSelectionHandlersOptions): (
  event: PointerEvent,
) => boolean {
  const { t } = useTranslation("renderer");
  return useCallback(
    (event) => {
      if (!regionSelection?.active || !regionSelection.dragging) {
        return false;
      }
      releasePointerCaptureSafely(stageRef.current, event.pointerId);
      const finalPoint = getNormalizedImagePoint(event);
      const completedSelection = finalPoint
        ? { ...regionSelection, current: finalPoint }
        : regionSelection;
      const bbox = regionSelectionToBbox(completedSelection);
      setRegionSelection(null);
      if (!isUsableRegionBbox(bbox, 10)) {
        pushStatus(t("regionTranslation.tooSmall"));
        return true;
      }
      void translateSelectedRegion(bbox);
      return true;
    },
    [
      getNormalizedImagePoint,
      pushStatus,
      regionSelection,
      setRegionSelection,
      stageRef,
      translateSelectedRegion,
      t,
    ],
  );
}
