import React from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../components/ui/IconButton";
import { DockIcon } from "../components/ui/icons";
import { useFloatingPanelDrag } from "./useFloatingPanelDrag";

/**
 * A draggable, resizable in-app floating panel portaled to document.body.
 *
 * Portaling to the body keeps it clear of the app grid and any backdrop-filter
 * stacking contexts. Drag/resize state lives in {@link useFloatingPanelDrag}.
 */
export function FloatingPanel({
  title,
  dockLabel,
  storageKey,
  onDock,
  children,
}: {
  title: string;
  dockLabel: string;
  storageKey: string;
  onDock: () => void;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const { rect, moveHandlers, resizeHandlers } =
    useFloatingPanelDrag(storageKey);
  if (!rect) {
    return null;
  }

  const node = (
    <div
      className="floating-panel"
      role="dialog"
      aria-label={title}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      }}
    >
      <header className="floating-panel-header" {...moveHandlers}>
        <span className="floating-panel-title">{title}</span>
        <IconButton
          size="sm"
          label={dockLabel}
          title={dockLabel}
          onClick={onDock}
        >
          <DockIcon size={15} />
        </IconButton>
      </header>
      <div className="floating-panel-body">{children}</div>
      <div
        className="floating-panel-resize"
        aria-hidden="true"
        {...resizeHandlers}
      />
    </div>
  );
  return createPortal(node, document.body);
}
