import React from "react";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type {
  BlockStylePresetSummary,
  CreateBlockStylePresetInput,
} from "../../../shared/blockStylePresets";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import { BlockDisplayGroup } from "./BlockDisplayGroup";
import { BlockStylePresetControls } from "./BlockStylePresetControls";
import { EditorColorGroup } from "./EditorColorGroup";
import { FormatEditorGroup } from "./EditorFormatControls";
import { EditorTextEffectGroup } from "./EditorTextEffectControls";
import { resolveEditorPanelModel } from "./editorPanelUtils";

type EditorFormatGroupsProps = {
  activeStylePresetId: string;
  block: TranslationBlock;
  canCreateStylePreset: boolean;
  disabled: boolean;
  disableChapterApply: boolean;
  fontFamilyDraft: string | undefined;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onApplyBlockBackgroundOpacity?: (scope: BlockBackgroundApplyScope) => void;
  onApplyFormat?: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onApplyStylePreset: (presetId: string) => void;
  onCreateStylePreset: (
    input: CreateBlockStylePresetInput,
  ) => boolean | Promise<boolean>;
  onDeleteStylePreset: (presetId: string) => boolean | Promise<boolean>;
  onOpenStylePresetManager?: () => void;
  onOpenFontManager?: () => void;
  onOverwriteStylePreset: (presetId: string) => boolean | Promise<boolean>;
  onRenameStylePreset: (
    presetId: string,
    name: string,
  ) => boolean | Promise<boolean>;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  resolvedFontSizePx: number | null;
  selectedBlockCount: number;
  showStylePresets?: boolean;
  setFontFamilyDraft: React.Dispatch<React.SetStateAction<string | undefined>>;
  stylePresets: readonly BlockStylePresetSummary[];
};

export function EditorFormatGroups({
  activeStylePresetId,
  block,
  canCreateStylePreset,
  disabled,
  disableChapterApply,
  fontFamilyDraft,
  onAdjustFontSize,
  onApplyBlockBackgroundOpacity,
  onApplyFormat,
  onApplyStylePreset,
  onCreateStylePreset,
  onDeleteStylePreset,
  onOpenStylePresetManager,
  onOpenFontManager,
  onOverwriteStylePreset,
  onRenameStylePreset,
  onUpdate,
  resolvedFontSizePx,
  selectedBlockCount,
  showStylePresets = true,
  setFontFamilyDraft,
  stylePresets,
}: EditorFormatGroupsProps): React.JSX.Element {
  const model = resolveEditorPanelModel(block, resolvedFontSizePx);
  return (
    <>
      {showStylePresets ? (
        <BlockStylePresetControls
          activePresetId={activeStylePresetId}
          canCreate={canCreateStylePreset}
          disabled={disabled}
          presets={stylePresets}
          onApply={onApplyStylePreset}
          onCreate={onCreateStylePreset}
          onDelete={onDeleteStylePreset}
          onManage={onOpenStylePresetManager}
          onOverwrite={onOverwriteStylePreset}
          onRename={onRenameStylePreset}
        />
      ) : null}
      <FormatEditorGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        fontFamilyDraft={fontFamilyDraft}
        model={model}
        onApplyFormat={onApplyFormat}
        onAdjustFontSize={onAdjustFontSize}
        onFontFamilyDraftChange={setFontFamilyDraft}
        onOpenFontManager={onOpenFontManager}
        onUpdate={onUpdate}
        selectedBlockCount={selectedBlockCount}
      />
      <EditorColorGroup
        block={block}
        disabled={disabled}
        model={model}
        onUpdate={onUpdate}
      />
      <EditorTextEffectGroup
        block={block}
        disabled={disabled}
        onUpdate={onUpdate}
      />
      <BlockDisplayGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        onApply={onApplyBlockBackgroundOpacity}
        onUpdate={onUpdate}
      />
    </>
  );
}
