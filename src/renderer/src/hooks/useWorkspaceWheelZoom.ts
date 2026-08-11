import { useEffect, useMemo, type RefObject } from "react";
import type { KeybindingOverrides } from "../../../shared/shortcutSettings";
import { comboFromWheelEvent } from "../lib/shortcuts/comboFromEvent";
import { resolveBindings } from "../lib/shortcuts/shortcutBindingResolution";
import { useEventCallback } from "./useEventCallback";

type UseWorkspaceWheelZoomOptions = {
  workspacePanelRef: RefObject<HTMLElement | null>;
  zoomIn: () => void;
  zoomOut: () => void;
  fitHeight?: () => void;
  overrides?: KeybindingOverrides;
};

/**
 * Dispatches wheel shortcuts for workspace zoom. The capture-phase listener
 * consumes a matching gesture before fixed page navigation sees it, while
 * requestAnimationFrame coalescing keeps trackpad bursts to one zoom step.
 */
export function useWorkspaceWheelZoom({
  workspacePanelRef,
  zoomIn,
  zoomOut,
  fitHeight,
  overrides = {},
}: UseWorkspaceWheelZoomOptions): void {
  const invokeZoomIn = useEventCallback(zoomIn);
  const invokeZoomOut = useEventCallback(zoomOut);
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
    let pendingZoomSteps = 0;
    const applyZoom = (): void => {
      frameId = null;
      const steps = pendingZoomSteps;
      pendingZoomSteps = 0;
      if (steps > 0) {
        invokeZoomIn();
      } else if (steps < 0) {
        invokeZoomOut();
      }
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
      pendingZoomSteps += action === "zoom-in" ? 1 : -1;
      if (frameId === null) {
        frameId = requestAnimationFrame(applyZoom);
      }
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
  }, [
    invokeFitHeight,
    invokeZoomIn,
    invokeZoomOut,
    resolveZoomAction,
    workspacePanelRef,
  ]);
}

function useZoomBindings(overrides: KeybindingOverrides) {
  return useMemo(() => resolveBindings(overrides), [overrides]);
}
