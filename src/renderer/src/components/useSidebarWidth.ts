import React from "react";
import { useWorkspacePreference } from "../hooks/useWorkspacePreference";
import { SIDEBAR_WIDTH_RANGE } from "../lib/workspacePreferences";

/** The image workspace keeps at least this much room beside the rails. */
const MIN_WORKSPACE_WIDTH_PX = 480;

export type SidebarWidthControl = {
  width: number | null;
  resizing: boolean;
  onResizeStart: () => void;
  onResize: (offsetPx: number) => void;
  onResizeEnd: () => void;
  reset: () => void;
};

/**
 * The dragged left-rail width. The shell (the resizer's parent) owns the grid
 * track, so the width is written there as a CSS variable — CSS clamps it again
 * on window resize — without re-rendering the shell's subtree per pointer move.
 */
export function useSidebarWidth(
  resizerRef: React.RefObject<HTMLElement | null>,
): SidebarWidthControl {
  const [width, setWidth, commit] = useWorkspacePreference("sidebarWidth", {
    commitDelayMs: 400,
  });
  const startRef = React.useRef<{ width: number; max: number } | null>(null);
  const [resizing, setResizing] = React.useState(false);

  const onResizeStart = React.useCallback(() => {
    const shell = resizerRef.current?.parentElement;
    if (!shell) return;
    const [sidebarTrack = 0, , rightTrack = 0] = readShellTracks(shell);
    const roomMax = shell.clientWidth - rightTrack - MIN_WORKSPACE_WIDTH_PX;
    startRef.current = {
      // Repeated arrow keys land while the grid track is still animating, so
      // a stored width is a steadier origin than the computed track.
      width: width ?? sidebarTrack,
      max: Math.max(
        SIDEBAR_WIDTH_RANGE.min,
        Math.min(SIDEBAR_WIDTH_RANGE.max, roomMax),
      ),
    };
    setResizing(true);
  }, [resizerRef, width]);

  const onResize = React.useCallback(
    (offsetPx: number) => {
      const start = startRef.current;
      if (!start) return;
      setWidth(
        Math.round(
          Math.max(
            SIDEBAR_WIDTH_RANGE.min,
            Math.min(start.max, start.width + offsetPx),
          ),
        ),
      );
    },
    [setWidth],
  );

  const onResizeEnd = React.useCallback(() => {
    startRef.current = null;
    setResizing(false);
    commit();
  }, [commit]);

  const reset = React.useCallback(() => setWidth(null), [setWidth]);

  React.useLayoutEffect(() => {
    const shell = resizerRef.current?.parentElement;
    if (!shell) return;
    shell.classList.toggle("has-custom-sidebar-width", width !== null);
    if (width === null) shell.style.removeProperty("--app-sidebar-user-width");
    else shell.style.setProperty("--app-sidebar-user-width", `${width}px`);
  }, [resizerRef, width]);

  React.useLayoutEffect(() => {
    resizerRef.current?.parentElement?.classList.toggle(
      "is-resizing-sidebar",
      resizing,
    );
  }, [resizerRef, resizing]);

  return { width, resizing, onResizeStart, onResize, onResizeEnd, reset };
}

function readShellTracks(shell: Element): number[] {
  return window
    .getComputedStyle(shell)
    .gridTemplateColumns.split(" ")
    .map((track) => Number.parseFloat(track) || 0);
}

/** The rendered left-rail width, for the separator's default-width state. */
export function measureSidebarWidth(handle: HTMLElement): number | null {
  const shell = handle.closest(".sidebar-width-resizer")?.parentElement;
  const [sidebarTrack] = shell ? readShellTracks(shell) : [];
  return sidebarTrack ? sidebarTrack : null;
}
