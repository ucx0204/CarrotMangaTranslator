import {
  useCallback,
  useRef,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { MangaPage } from "../../../shared/libraryTypes";
import { isUsableRegionBbox } from "../../../shared/region";
import type { BBox } from "../../../shared/textTypes";
import type { InpaintingTool } from "../inpainting/inpaintingTypes";
import {
  regionSelectionToBbox,
  type RegionSelectionState,
} from "../lib/appHelpers";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import {
  capturePointerSafely,
  releasePointerCaptureSafely,
} from "./workspacePointerCapture";
import {
  resolveNormalizedImagePoint,
  type PointerRect,
} from "./workspacePointerGeometry";

type ActiveRegionSelection = {
  current: { x: number; y: number };
  pointerId: number;
  pointerRect: PointerRect;
  start: { x: number; y: number };
};

type UseWorkspaceRegionSelectionHandlersOptions = {
  getImagePointerRect: () => PointerRect | null;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  jobActive: boolean;
  pushStatus: (line: string) => void;
  regionSelection: RegionSelectionState | null;
  selectedPage: MangaPage | null;
  regionTranslationReady: boolean;
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
  const activeRef = useRef<ActiveRegionSelection | null>(null);
  const cancelRegionSelection = useCancelRegionSelection(options, activeRef);
  const startRegionTranslationSelection = useStartRegionTranslationSelection(
    options,
    cancelRegionSelection,
  );

  return {
    cancelRegionSelection,
    onRegionPointerDown: useRegionPointerDown(options, activeRef),
    onRegionPointerMove: useRegionPointerMove(options, activeRef),
    onRegionPointerUp: useRegionPointerUp(options, activeRef),
    startRegionTranslationSelection,
  };
}

function useCancelRegionSelection(
  {
    interactionPreviewStore,
    pushStatus,
    regionSelection,
    setRegionSelection,
    stageRef,
  }: UseWorkspaceRegionSelectionHandlersOptions,
  activeRef: MutableRefObject<ActiveRegionSelection | null>,
): () => boolean {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    const active = activeRef.current;
    if (!regionSelection?.active && !active) {
      return false;
    }
    if (active) {
      releasePointerCaptureSafely(stageRef.current, active.pointerId);
      activeRef.current = null;
    }
    interactionPreviewStore.set({ regionSelectionRect: null });
    setRegionSelection(null);
    pushStatus(t("regionTranslation.cancelledSelection"));
    return true;
  }, [
    activeRef,
    interactionPreviewStore,
    pushStatus,
    regionSelection?.active,
    setRegionSelection,
    stageRef,
    t,
  ]);
}

function useStartRegionTranslationSelection(
  {
    jobActive,
    pushStatus,
    regionTranslationReady,
    selectedPage,
    setInpaintingTool,
    setRegionSelection,
    setSelectedBlockId,
  }: UseWorkspaceRegionSelectionHandlersOptions,
  cancelRegionSelection: () => boolean,
): () => void {
  const { t } = useTranslation("renderer");
  return useCallback(() => {
    if (!selectedPage || !regionTranslationReady || jobActive) {
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
    regionTranslationReady,
    selectedPage,
    setInpaintingTool,
    setRegionSelection,
    setSelectedBlockId,
    t,
  ]);
}

function useRegionPointerDown(
  {
    getImagePointerRect,
    interactionPreviewStore,
    regionTranslationReady,
    regionSelection,
    setRegionSelection,
    setSelectedBlockId,
    stageRef,
  }: UseWorkspaceRegionSelectionHandlersOptions,
  activeRef: MutableRefObject<ActiveRegionSelection | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      if (!regionSelection?.active) {
        return false;
      }
      if (!regionTranslationReady) {
        setRegionSelection(null);
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
      event.stopPropagation();
      setSelectedBlockId(null);
      activeRef.current = {
        current: point,
        pointerId: event.pointerId,
        pointerRect,
        start: point,
      };
      interactionPreviewStore.set({
        regionSelectionRect: selectionToBbox(activeRef.current),
      });
      capturePointerSafely(stageRef.current, event.pointerId);
      return true;
    },
    [
      activeRef,
      getImagePointerRect,
      interactionPreviewStore,
      regionTranslationReady,
      regionSelection?.active,
      setRegionSelection,
      setSelectedBlockId,
      stageRef,
    ],
  );
}

function useRegionPointerMove(
  {
    interactionPreviewStore,
    regionTranslationReady,
    setRegionSelection,
  }: UseWorkspaceRegionSelectionHandlersOptions,
  activeRef: MutableRefObject<ActiveRegionSelection | null>,
): (event: PointerEvent) => boolean {
  return useCallback(
    (event) => {
      const active = activeRef.current;
      if (!active) {
        return false;
      }
      if (!regionTranslationReady) {
        activeRef.current = null;
        interactionPreviewStore.set({ regionSelectionRect: null });
        setRegionSelection(null);
        return true;
      }
      const point = resolveNormalizedImagePoint(event, active.pointerRect);
      if (point) {
        active.current = point;
        interactionPreviewStore.queue({
          regionSelectionRect: selectionToBbox(active),
        });
      }
      return true;
    },
    [
      activeRef,
      interactionPreviewStore,
      regionTranslationReady,
      setRegionSelection,
    ],
  );
}

function useRegionPointerUp(
  {
    interactionPreviewStore,
    pushStatus,
    regionTranslationReady,
    setRegionSelection,
    stageRef,
    translateSelectedRegion,
  }: UseWorkspaceRegionSelectionHandlersOptions,
  activeRef: MutableRefObject<ActiveRegionSelection | null>,
): (event: PointerEvent) => boolean {
  const { t } = useTranslation("renderer");
  return useCallback(
    (event) => {
      const active = activeRef.current;
      if (!active) {
        return false;
      }
      releasePointerCaptureSafely(stageRef.current, active.pointerId);
      activeRef.current = null;
      interactionPreviewStore.set({ regionSelectionRect: null });
      setRegionSelection(null);
      if (!regionTranslationReady || event.type === "pointercancel") {
        return true;
      }
      const finalPoint = resolveNormalizedImagePoint(event, active.pointerRect);
      if (finalPoint) active.current = finalPoint;
      const bbox = selectionToBbox(active);
      if (!isUsableRegionBbox(bbox, 10)) {
        pushStatus(t("regionTranslation.tooSmall"));
        return true;
      }
      void translateSelectedRegion(bbox);
      return true;
    },
    [
      activeRef,
      interactionPreviewStore,
      pushStatus,
      regionTranslationReady,
      setRegionSelection,
      stageRef,
      translateSelectedRegion,
      t,
    ],
  );
}

function selectionToBbox(selection: {
  current: { x: number; y: number };
  start: { x: number; y: number };
}): BBox {
  return regionSelectionToBbox({
    active: true,
    dragging: true,
    start: selection.start,
    current: selection.current,
  });
}
