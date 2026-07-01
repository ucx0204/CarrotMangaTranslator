import React from "react";
import { EditorPanel } from "../components/EditorPanel";
import { IconButton } from "../components/ui";
import { ExpandIcon, FloatIcon } from "../components/ui/icons";
import { usePanelSession } from "./panelSession";

/**
 * Wires the presentational {@link EditorPanel} to {@link usePanelSession}, so it
 * renders identically whether docked in the rail, floating in an in-app panel,
 * or popped out into its own OS window. All state/actions come from the panel
 * session context.
 *
 * Detach controls (float / pop-out) show only in the docked rail view; the
 * floating panel and pop-out window own their own dock-back affordances.
 */
export function EditorPanelContainer(): React.JSX.Element {
  const session = usePanelSession();
  const detachControls =
    session.showDetachControls && !session.editorFloating ? (
      <>
        <IconButton
          size="sm"
          label="편집기 띄우기"
          title="편집기를 띄워 크게 편집"
          onClick={session.onToggleEditorFloat}
        >
          <ExpandIcon size={15} />
        </IconButton>
        <IconButton
          size="sm"
          label="편집기 새 창"
          title="편집기를 새 창으로 분리"
          onClick={session.onPopOutEditor}
        >
          <FloatIcon size={15} />
        </IconButton>
      </>
    ) : undefined;
  return (
    <EditorPanel
      block={session.selectedBlock}
      disabled={session.editorDisabled}
      disableChapterApply={session.disableChapterApply}
      areaTranslateAvailable={session.areaTranslateAvailable}
      areaTranslateSelecting={session.areaTranslateSelecting}
      selectedBlockCount={session.selectedBlockCount}
      headerActions={detachControls}
      onStartAreaTranslate={session.onStartAreaTranslate}
      onApplyFormat={session.onApplyFormat}
      onUpdate={session.onUpdateBlock}
      onDelete={session.onDeleteBlock}
      onDuplicate={session.onDuplicateBlock}
    />
  );
}
