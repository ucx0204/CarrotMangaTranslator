import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { WheelZoomSensitivityPercent } from "../../../shared/settingsTypes";
import {
  clampWorkspaceZoom,
  stepWorkspaceZoom,
  type WorkspaceFitMode,
  type WorkspaceWheelZoomGesture,
  type WorkspaceZoomAnchorMode,
  type WorkspaceZoomController,
} from "../lib/workspaceZoom";
import { useEventCallback } from "./useEventCallback";
import {
  captureWorkspaceZoomAnchor,
  resolveSelectedBlockCenter,
  restoreWorkspaceZoomAnchor,
  type PendingWorkspaceZoomAnchor,
  type WorkspaceZoomAnchorSpec as ZoomAnchorSpec,
} from "../lib/workspaceZoomAnchors";

/** A conventional Windows wheel notch is roughly 100 delta pixels. */
const WHEEL_DELTA_PIXELS_PER_NOTCH = 100;
/** Keep the anchor through scrollbar/ResizeObserver stabilization only. */
const ZOOM_ANCHOR_SETTLE_MS = 64;

type UseWorkspaceZoomControllerOptions = {
  controllerRef: React.RefObject<WorkspaceZoomController | null>;
  fitMode: WorkspaceFitMode;
  imageRef: React.RefObject<HTMLImageElement | null>;
  layoutHeight: number | null;
  layoutWidth: number | null;
  onChangeZoom: (zoom: number) => void;
  page: MangaPage | null;
  pageFits: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  selectedBlockId: string | null;
  selectedBlockIds: readonly string[];
  wheelZoomSensitivityPercent?: WheelZoomSensitivityPercent;
  zoom: number;
};

/**
 * Owns the live zoom camera. Every input changes the real layout zoom directly;
 * there is no interpolation or trailing animation. Before the layout update it
 * records an image coordinate, then restores that coordinate to the same screen
 * pixel after the image and overlays resize together.
 */
export function useWorkspaceZoomController({
  controllerRef,
  fitMode,
  imageRef,
  layoutHeight,
  layoutWidth,
  onChangeZoom,
  page,
  pageFits,
  panelRef,
  selectedBlockId,
  selectedBlockIds,
  wheelZoomSensitivityPercent = 1,
  zoom,
}: UseWorkspaceZoomControllerOptions): void {
  const runtime = useWorkspaceZoomRuntime(fitMode, page?.id ?? null, zoom);
  const anchors = useWorkspaceZoomAnchors({
    imageRef,
    layoutHeight,
    layoutWidth,
    pageFits,
    pageId: page?.id ?? null,
    panelRef,
    pendingAnchorRef: runtime.pendingAnchor,
  });
  const requestZoom = useWorkspaceZoomCommit({
    applyPendingAnchor: anchors.applyPending,
    captureAnchor: anchors.capture,
    onChangeZoom,
    runtime,
  });
  const resolveAnchor = useZoomAnchorResolver(
    page,
    selectedBlockId,
    selectedBlockIds,
  );
  const controller = useZoomControllerValue(
    requestZoom,
    resolveAnchor,
    runtime,
    wheelZoomSensitivityPercent,
  );
  useWorkspaceZoomLifecycle({
    controller,
    controllerRef,
    fitMode,
    pageId: page?.id ?? null,
    runtime,
    zoom,
  });
}

type WorkspaceZoomRuntime = {
  anchorReleaseTimer: React.RefObject<number | null>;
  identity: React.RefObject<{
    fitMode: WorkspaceFitMode;
    pageId: string | null;
  }>;
  liveZoom: React.RefObject<number>;
  pendingAnchor: React.RefObject<PendingWorkspaceZoomAnchor | null>;
};

function useWorkspaceZoomRuntime(
  fitMode: WorkspaceFitMode,
  pageId: string | null,
  zoom: number,
): WorkspaceZoomRuntime {
  const identity = React.useRef({ fitMode, pageId });
  const anchorReleaseTimer = React.useRef<number | null>(null);
  const liveZoom = React.useRef(zoom);
  const pendingAnchor = React.useRef<PendingWorkspaceZoomAnchor | null>(null);
  return React.useMemo(
    () => ({
      anchorReleaseTimer,
      identity,
      liveZoom,
      pendingAnchor,
    }),
    [],
  );
}

function useWorkspaceZoomAnchors({
  imageRef,
  layoutHeight,
  layoutWidth,
  pageFits,
  pageId,
  panelRef,
  pendingAnchorRef,
}: Pick<
  UseWorkspaceZoomControllerOptions,
  "imageRef" | "layoutHeight" | "layoutWidth" | "pageFits" | "panelRef"
> & {
  pageId: string | null;
  pendingAnchorRef: React.RefObject<PendingWorkspaceZoomAnchor | null>;
}): {
  applyPending: () => void;
  capture: (spec: ZoomAnchorSpec) => PendingWorkspaceZoomAnchor | null;
} {
  const capture = useEventCallback((spec: ZoomAnchorSpec) =>
    captureWorkspaceZoomAnchor({
      image: imageRef.current,
      pageId,
      panel: panelRef.current,
      spec,
    }),
  );
  const applyPending = useEventCallback(() => {
    const pending = pendingAnchorRef.current;
    if (!pending || pending.pageId !== pageId) return;
    if (pageFits) resetWorkspaceScroll(panelRef.current);
    else
      restoreWorkspaceZoomAnchor({
        anchor: pending,
        image: imageRef.current,
        panel: panelRef.current,
      });
  });
  React.useLayoutEffect(
    () => applyPending(),
    [applyPending, layoutHeight, layoutWidth, pageFits],
  );
  return { applyPending, capture };
}

function useWorkspaceZoomCommit({
  applyPendingAnchor,
  captureAnchor,
  onChangeZoom,
  runtime,
}: {
  applyPendingAnchor: () => void;
  captureAnchor: (spec: ZoomAnchorSpec) => PendingWorkspaceZoomAnchor | null;
  onChangeZoom: (zoom: number) => void;
  runtime: WorkspaceZoomRuntime;
}): (target: number, spec: ZoomAnchorSpec) => void {
  return useEventCallback((target: number, spec: ZoomAnchorSpec) => {
    const next = clampWorkspaceZoom(target);
    runtime.pendingAnchor.current = captureAnchor(spec);
    scheduleWorkspaceZoomAnchorRelease(runtime);
    if (Math.abs(next - runtime.liveZoom.current) < 0.00005) {
      applyPendingAnchor();
      return;
    }
    runtime.liveZoom.current = next;
    onChangeZoom(next);
  });
}

function useZoomAnchorResolver(
  page: MangaPage | null,
  selectedBlockId: string | null,
  selectedBlockIds: readonly string[],
): (mode: WorkspaceZoomAnchorMode) => ZoomAnchorSpec {
  return useEventCallback((mode: WorkspaceZoomAnchorMode) => {
    if (mode === "selection") {
      const center = resolveSelectedBlockCenter(
        page,
        selectedBlockId,
        selectedBlockIds,
      );
      if (center)
        return { kind: "selection", pageX: center.x, pageY: center.y };
    }
    return { kind: "viewport" };
  });
}

function useZoomControllerValue(
  requestZoom: (target: number, spec: ZoomAnchorSpec) => void,
  resolveAnchor: (mode: WorkspaceZoomAnchorMode) => ZoomAnchorSpec,
  runtime: WorkspaceZoomRuntime,
  wheelZoomSensitivityPercent: WheelZoomSensitivityPercent,
): WorkspaceZoomController {
  return React.useMemo(() => {
    const step = (
      direction: "in" | "out",
      anchor: WorkspaceZoomAnchorMode,
    ): void =>
      requestZoom(
        stepWorkspaceZoom(runtime.liveZoom.current, direction),
        resolveAnchor(anchor),
      );
    return {
      resetAtViewport: () => requestZoom(1, resolveAnchor("viewport")),
      zoomAtPointer: (gesture: WorkspaceWheelZoomGesture) => {
        const ratio = resolveWheelZoomRatio(
          gesture.deltaPixels,
          wheelZoomSensitivityPercent,
        );
        requestZoom(
          gesture.direction === "in"
            ? runtime.liveZoom.current * ratio
            : runtime.liveZoom.current / ratio,
          {
            kind: "client",
            point: { x: gesture.clientX, y: gesture.clientY },
          },
        );
      },
      zoomInAtSelection: () => step("in", "selection"),
      zoomOutAtViewport: () => step("out", "viewport"),
    };
  }, [requestZoom, resolveAnchor, runtime, wheelZoomSensitivityPercent]);
}

function useWorkspaceZoomLifecycle({
  controller,
  controllerRef,
  fitMode,
  pageId,
  runtime,
  zoom,
}: {
  controller: WorkspaceZoomController;
  controllerRef: React.RefObject<WorkspaceZoomController | null>;
  fitMode: WorkspaceFitMode;
  pageId: string | null;
  runtime: WorkspaceZoomRuntime;
  zoom: number;
}): void {
  React.useLayoutEffect(() => {
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [controller, controllerRef]);
  React.useLayoutEffect(() => {
    const changed =
      fitMode !== runtime.identity.current.fitMode ||
      pageId !== runtime.identity.current.pageId;
    runtime.identity.current = { fitMode, pageId };
    if (changed) {
      clearWorkspaceZoomAnchor(runtime);
    }
    runtime.liveZoom.current = zoom;
  }, [fitMode, pageId, runtime, zoom]);
  React.useEffect(
    () => () => {
      clearWorkspaceZoomAnchor(runtime);
    },
    [runtime],
  );
}

function scheduleWorkspaceZoomAnchorRelease(
  runtime: WorkspaceZoomRuntime,
): void {
  if (runtime.anchorReleaseTimer.current !== null) {
    window.clearTimeout(runtime.anchorReleaseTimer.current);
  }
  runtime.anchorReleaseTimer.current = window.setTimeout(() => {
    runtime.anchorReleaseTimer.current = null;
    runtime.pendingAnchor.current = null;
  }, ZOOM_ANCHOR_SETTLE_MS);
}

function clearWorkspaceZoomAnchor(runtime: WorkspaceZoomRuntime): void {
  if (runtime.anchorReleaseTimer.current !== null) {
    window.clearTimeout(runtime.anchorReleaseTimer.current);
    runtime.anchorReleaseTimer.current = null;
  }
  runtime.pendingAnchor.current = null;
}

export function resolveWheelZoomRatio(
  deltaPixels: number,
  sensitivityPercent = 1,
): number {
  if (!Number.isFinite(deltaPixels)) return 1;
  const notchCount = Math.abs(deltaPixels) / WHEEL_DELTA_PIXELS_PER_NOTCH;
  const normalizedPercent =
    Number.isInteger(sensitivityPercent) &&
    sensitivityPercent >= 1 &&
    sensitivityPercent <= 10
      ? sensitivityPercent
      : 1;
  return Math.exp(Math.log(1 + normalizedPercent / 100) * notchCount);
}

function resetWorkspaceScroll(panel: HTMLElement | null): void {
  if (!panel) return;
  panel.scrollLeft = 0;
  panel.scrollTop = 0;
}
