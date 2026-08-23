import React from "react";
import { IconArrowLeft, IconLibrary } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { EditorPanel } from "../components/EditorPanel";
import { SaveBlockLibraryModal } from "../components/SaveBlockLibraryModal";
import { IconButton } from "../components/ui/IconButton";
import { ExpandIcon, FloatIcon } from "../components/ui/icons";
import { usePanelSession, type PanelSessionValue } from "./panelSession";

export function EditorPanelContainer(): React.JSX.Element {
  const session = usePanelSession();
  const [saveOpen, setSaveOpen] = React.useState(false);
  return (
    <>
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
        headerActions={
          <EditorPanelHeaderActions
            session={session}
            onOpenLibrary={session.onOpenBlockLibrary}
          />
        }
        stylePresets={session.blockStylePresets}
        onStartAreaTranslate={session.onStartAreaTranslate}
        onApplyFormat={session.onApplyFormat}
        onApplyStylePreset={session.onApplyStylePreset}
        onCreateStylePreset={session.onCreateStylePreset}
        onDeleteStylePreset={session.onDeleteStylePreset}
        onApplyBlockBackgroundOpacity={session.onApplyBlockBackgroundOpacity}
        onAdjustFontSize={session.onAdjustFontSize}
        onUpdate={session.onUpdateBlock}
        onDelete={session.onDeleteBlock}
        onDuplicate={session.onDuplicateBlock}
        onSaveToLibrary={() => setSaveOpen(true)}
        onEraseOriginal={session.onEraseBlockOriginal}
        onFitBubble={session.onFitBlockBubble}
        onRemoveBubbleLayout={session.onRemoveBubbleLayout}
        onSelectTransformMode={session.onSelectTransformMode}
      />
      <EditorPanelLibraryModals
        saveOpen={saveOpen}
        session={session}
        onCloseSave={() => setSaveOpen(false)}
      />
    </>
  );
}

function EditorPanelHeaderActions({
  onOpenLibrary,
  session,
}: {
  onOpenLibrary: () => void;
  session: PanelSessionValue;
}): React.JSX.Element {
  const { t } = useTranslation("renderer");
  const { t: tComponents } = useTranslation("components");
  const showDetach = session.showDetachControls && !session.editorFloating;
  return (
    <>
      <IconButton
        size="sm"
        label={tComponents("blockLibrary.open")}
        onClick={onOpenLibrary}
      >
        <IconLibrary size={16} aria-hidden="true" />
      </IconButton>
      {showDetach && !session.editorPoppedOut ? (
        <IconButton
          size="sm"
          label={tComponents("pageBlocks.backToList")}
          onClick={session.onBackToPageBlocks}
        >
          <IconArrowLeft size={16} aria-hidden="true" />
        </IconButton>
      ) : null}
      {showDetach ? (
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
      ) : null}
    </>
  );
}

function EditorPanelLibraryModals({
  onCloseSave,
  saveOpen,
  session,
}: {
  onCloseSave: () => void;
  saveOpen: boolean;
  session: PanelSessionValue;
}): React.JSX.Element {
  return (
    <>
      {saveOpen && session.selectedBlock && session.selectedPageSize ? (
        <SaveBlockLibraryModal
          block={session.selectedBlock}
          pageSize={session.selectedPageSize}
          onClose={onCloseSave}
        />
      ) : null}
    </>
  );
}
