import React from "react";
import { useTranslation } from "react-i18next";
import { EditorPanel } from "../components/EditorPanel";
import { IconButton } from "../components/ui/IconButton";
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
  const { t } = useTranslation("renderer");
  const session = usePanelSession();
  const detachControls =
    session.showDetachControls && !session.editorFloating ? (
      <>
        <IconButton
          size="sm"
          label={t("panels.editor.float")}
          title={t("panels.editor.floatTitle")}
          onClick={session.onToggleEditorFloat}
        >
          <ExpandIcon size={15} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("panels.editor.popOut")}
          title={t("panels.editor.popOutTitle")}
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
      pageSize={session.selectedPageSize}
      transformMode={session.transformMode}
      headerActions={detachControls}
      onStartAreaTranslate={session.onStartAreaTranslate}
      onApplyFormat={session.onApplyFormat}
      onApplyBlockBackgroundOpacity={session.onApplyBlockBackgroundOpacity}
      onAdjustFontSize={session.onAdjustFontSize}
      onUpdate={session.onUpdateBlock}
      onDelete={session.onDeleteBlock}
      onDuplicate={session.onDuplicateBlock}
      onRemoveBubbleLayout={session.onRemoveBubbleLayout}
      onSelectTransformMode={session.onSelectTransformMode}
    />
  );
}
