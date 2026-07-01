import React from "react";
import { EditorPanelContainer } from "./EditorPanelContainer";
import { FloatingPanel } from "./FloatingPanel";
import { usePanelSession } from "./panelSession";

/**
 * Renders the block editor in a floating in-app panel when it is detached from
 * the rail. Mounted once at the session root, inside the panel session provider.
 */
export function EditorFloatingLayer(): React.JSX.Element | null {
  const session = usePanelSession();
  if (!session.editorFloating) {
    return null;
  }
  return (
    <FloatingPanel
      title="블록 편집"
      dockLabel="편집기 도킹"
      storageKey="panel.float.editor"
      onDock={session.onToggleEditorFloat}
    >
      <EditorPanelContainer />
    </FloatingPanel>
  );
}
