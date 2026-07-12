import React from "react";
import { useTranslation } from "react-i18next";
import { EditorPanelContainer } from "./EditorPanelContainer";
import { FloatingPanel } from "./FloatingPanel";
import { usePanelSession } from "./panelSession";

/**
 * Renders the block editor in a floating in-app panel when it is detached from
 * the rail. Mounted once at the session root, inside the panel session provider.
 */
export function EditorFloatingLayer(): React.JSX.Element | null {
  const { t } = useTranslation("renderer");
  const session = usePanelSession();
  if (!session.editorFloating) {
    return null;
  }
  return (
    <FloatingPanel
      title={t("panels.editor.title")}
      dockLabel={t("panels.editor.dock")}
      storageKey="panel.float.editor"
      onDock={session.onToggleEditorFloat}
    >
      <EditorPanelContainer />
    </FloatingPanel>
  );
}
