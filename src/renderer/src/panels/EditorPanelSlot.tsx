import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";
import { EditorPanelContainer } from "./EditorPanelContainer";
import { usePanelSession } from "./panelSession";

/**
 * Rail slot for the block editor. When the editor is detached — floating in-app
 * or popped out into its own OS window — the rail shows a compact placeholder
 * with a dock-back action. The detached instance is rendered by
 * {@link EditorFloatingLayer} (in-app) or the pop-out window (OS).
 */
export function EditorPanelSlot(): React.JSX.Element {
  const { t } = useTranslation("renderer");
  const session = usePanelSession();
  if (session.editorPoppedOut) {
    return (
      <section className="editor-panel editor-float-placeholder">
        <p className="muted-line">{t("panels.editor.poppedOut")}</p>
        <Button size="sm" onClick={session.onDockEditorWindow}>
          {t("panels.editor.closeWindow")}
        </Button>
      </section>
    );
  }
  if (session.editorFloating) {
    return (
      <section className="editor-panel editor-float-placeholder">
        <p className="muted-line">{t("panels.editor.floating")}</p>
        <Button size="sm" onClick={session.onToggleEditorFloat}>
          {t("panels.editor.dock")}
        </Button>
      </section>
    );
  }
  return <EditorPanelContainer />;
}
