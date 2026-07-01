import React from "react";
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
  const session = usePanelSession();
  if (session.editorPoppedOut) {
    return (
      <section className="editor-panel editor-float-placeholder">
        <p className="muted-line">편집기를 새 창으로 분리했어요.</p>
        <Button size="sm" onClick={session.onDockEditorWindow}>
          편집기 창 닫기
        </Button>
      </section>
    );
  }
  if (session.editorFloating) {
    return (
      <section className="editor-panel editor-float-placeholder">
        <p className="muted-line">편집기를 띄웠어요.</p>
        <Button size="sm" onClick={session.onToggleEditorFloat}>
          편집기 도킹
        </Button>
      </section>
    );
  }
  return <EditorPanelContainer />;
}
