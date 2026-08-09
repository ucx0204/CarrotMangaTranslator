import React from "react";
import { useTranslation } from "react-i18next";
import { EditorPanel } from "../components/EditorPanel";
import { IconButton } from "../components/ui/IconButton";
import { ExpandIcon, FloatIcon } from "../components/ui/icons";
import { IconArrowLeft } from "@tabler/icons-react";
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
  const { t: tComponents } = useTranslation("components");
  const session = usePanelSession();
  const backAction =
    session.showDetachControls &&
    !session.editorFloating &&
    !session.editorPoppedOut ? (
      <IconButton
        size="sm"
        label={tComponents("pageBlocks.backToList")}
        title={tComponents("pageBlocks.backToList")}
        onClick={session.onBackToPageBlocks}
      >
        <IconArrowLeft size={16} aria-hidden="true" />
      </IconButton>
    ) : null;
  const detachControls =
    session.showDetachControls && !session.editorFloating ? (
      <>
        {backAction}
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
      canCreateStylePreset={session.canCreateStylePreset}
      disabled={session.editorDisabled}
      disableChapterApply={session.disableChapterApply}
      areaTranslateAvailable={session.areaTranslateAvailable}
      areaTranslateSelecting={session.areaTranslateSelecting}
      selectedBlockCount={session.selectedBlockCount}
      pageSize={session.selectedPageSize}
      transformMode={session.transformMode}
      headerActions={detachControls}
      stylePresets={session.blockStylePresets}
      onStartAreaTranslate={session.onStartAreaTranslate}
      onApplyFormat={session.onApplyFormat}
      onApplyStylePreset={session.onApplyStylePreset}
      onCreateStylePreset={session.onCreateStylePreset}
      onApplyBlockBackgroundOpacity={session.onApplyBlockBackgroundOpacity}
      onAdjustFontSize={session.onAdjustFontSize}
      onUpdate={session.onUpdateBlock}
      onDelete={session.onDeleteBlock}
      onDuplicate={session.onDuplicateBlock}
      onEraseOriginal={session.onEraseBlockOriginal}
      onFitBubble={session.onFitBlockBubble}
      onRemoveBubbleLayout={session.onRemoveBubbleLayout}
      onSelectTransformMode={session.onSelectTransformMode}
    />
  );
}
