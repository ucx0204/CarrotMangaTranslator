import React from "react";
import { useTranslation } from "react-i18next";
import { IconRestore } from "@tabler/icons-react";
import { SIDEBAR_WIDTH_RANGE } from "../lib/workspacePreferences";
import { IconButton } from "./ui/IconButton";
import { ResizeHandle } from "./ui/ResizeHandle";
import { measureSidebarWidth, useSidebarWidth } from "./useSidebarWidth";

/** Keeps the reset chip clear of the window's top and bottom edges. */
const RESET_EDGE_INSET_PX = 20;

/**
 * Drag handle on the left rail's edge, rendered directly inside the app shell.
 * Once the width is customized, a reset chip appears beside the pointer only
 * while the edge is hovered or focused.
 */
export function SidebarWidthResizer(): React.JSX.Element {
  const { t } = useTranslation("components");
  const zoneRef = React.useRef<HTMLDivElement>(null);
  const control = useSidebarWidth(zoneRef);
  const customized = control.width !== null;

  const followPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const zone = zoneRef.current;
    if (!zone || control.resizing) return;
    if ((event.target as Element).closest("button")) return;
    const bounds = zone.getBoundingClientRect();
    const y = Math.max(
      RESET_EDGE_INSET_PX,
      Math.min(bounds.height - RESET_EDGE_INSET_PX, event.clientY - bounds.top),
    );
    zone.style.setProperty("--sidebar-width-reset-y", `${y}px`);
  };

  const reset = (): void => {
    control.reset();
    // The chip unmounts with the custom width; keep focus on the edge.
    zoneRef.current
      ?.querySelector<HTMLElement>("[role='separator']")
      ?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={zoneRef}
      className="sidebar-width-resizer"
      onPointerMove={followPointer}
    >
      <ResizeHandle
        orientation="vertical"
        label={t("sidebar.resizeWidth")}
        title={t("sidebar.resizeWidthHint")}
        valueNow={control.width ?? undefined}
        measureValue={measureSidebarWidth}
        valueMin={SIDEBAR_WIDTH_RANGE.min}
        valueMax={SIDEBAR_WIDTH_RANGE.max}
        onResizeStart={control.onResizeStart}
        onResize={control.onResize}
        onResizeEnd={control.onResizeEnd}
        onReset={control.reset}
      />
      {customized ? (
        <IconButton
          variant="dock"
          size="sm"
          className="sidebar-width-reset"
          label={t("sidebar.resetWidth")}
          onClick={reset}
        >
          <IconRestore size={15} aria-hidden="true" />
        </IconButton>
      ) : null}
    </div>
  );
}
