import { useEffect, useMemo, type RefObject } from "react";
import type { KeybindingOverrides } from "../../../shared/shortcutSettings";
import { comboFromWheelEvent } from "../lib/shortcuts/comboFromEvent";
import { resolveBindings } from "../lib/shortcuts/shortcutBindingResolution";
import type { WorkspaceWheelZoomGesture } from "../lib/workspaceZoom";
import { useEventCallback } from "./useEventCallback";

type UseWorkspaceWheelZoomOptions = {
  workspacePanelRef: RefObject<HTMLElement | null>;
  zoom: (gesture: WorkspaceWheelZoomGesture) => void;
  fitHeight?: () => void;
  overrides?: KeybindingOverrides;
};

/**
 * Dispatches wheel shortcuts for workspace zoom. The capture-phase listener
 * consumes a matching gesture before fixed page navigation sees it. Magnitude
 * and pointer coordinates are retained. Events within one display frame are
 * summed into one real zoom update; no additional interpolation continues after
 * the physical wheel input stops.
 */
export function useWorkspaceWheelZoom({
  workspacePanelRef,
  zoom,
  fitHeight,
  overrides = {},
}: UseWorkspaceWheelZoomOptions): void {
  const invokeZoom = useEventCallback(zoom);
  const invokeFitHeight = useEventCallback(() => fitHeight?.());
  const bindings = useZoomBindings(overrides);
  const resolveZoomAction = useEventCallback(
    (event: WheelEvent): "zoom-in" | "zoom-out" | null => {
      const combo = comboFromWheelEvent(event);
      if (!combo) {
        return null;
      }
      const actionId = bindings.get(combo);
      return actionId === "zoom-in" || actionId === "zoom-out"
        ? actionId
        : null;
    },
  );
  useEffect(() => {
    const panel = workspacePanelRef.current;
    if (!panel) {
      return;
    }
    let frameId: number | null = null;
    let pendingClientX = 0;
    let pendingClientY = 0;
    let pendingSignedDelta = 0;
    const flushZoom = (): void => {
      frameId = null;
      const signedDelta = pendingSignedDelta;
      pendingSignedDelta = 0;
      if (Math.abs(signedDelta) < 0.001) return;
      invokeZoom({
        clientX: pendingClientX,
        clientY: pendingClientY,
        deltaPixels: Math.abs(signedDelta),
        direction: signedDelta > 0 ? "in" : "out",
      });
    };
    const onWheel = (event: WheelEvent): void => {
      const action = resolveZoomAction(event);
      if (!action) {
        // Never let an unbound or reassigned workspace gesture fall through to
        // Chromium's page zoom, which would scale the entire application UI.
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
        }
        return;
      }
      event.preventDefault();
      pendingClientX = event.clientX;
      pendingClientY = event.clientY;
      pendingSignedDelta +=
        resolveWheelDeltaPixels(event, panel.clientHeight) *
        (action === "zoom-in" ? 1 : -1);
      if (frameId === null) frameId = requestAnimationFrame(flushZoom);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 1 || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      invokeFitHeight();
    };
    panel.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    panel.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      panel.removeEventListener("wheel", onWheel, true);
      panel.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [invokeFitHeight, invokeZoom, resolveZoomAction, workspacePanelRef]);
}

function resolveWheelDeltaPixels(
  event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "shiftKey">,
  pageHeight: number,
): number {
  const raw =
    event.deltaY && Math.abs(event.deltaY) >= Math.abs(event.deltaX)
      ? event.deltaY
      : event.shiftKey
        ? event.deltaX
        : event.deltaY;
  const unit =
    event.deltaMode === 1
      ? 40
      : event.deltaMode === 2
        ? Math.max(1, pageHeight)
        : 1;
  return Math.max(0.25, Math.abs(raw * unit));
}

function useZoomBindings(overrides: KeybindingOverrides) {
  return useMemo(() => resolveBindings(overrides), [overrides]);
}
