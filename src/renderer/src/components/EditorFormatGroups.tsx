import React from "react";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type {
  BlockStylePresetSummary,
  CreateBlockStylePresetInput,
} from "../../../shared/blockStylePresets";
import type { TranslationBlock } from "../../../shared/textTypes";
import type {
  PanelFormatFieldKey,
  PanelFormatSelection,
} from "../../../shared/panelBridgeTypes";
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
  formatSelection: PanelFormatSelection;
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

export function EditorFormatGroups(
  props: EditorFormatGroupsProps,
): React.JSX.Element {
  const {
    block,
    disabled,
    disableChapterApply,
    fontFamilyDraft,
    formatSelection,
    onAdjustFontSize,
    onApplyBlockBackgroundOpacity,
    onApplyFormat,
    onOpenFontManager,
    onUpdate,
    resolvedFontSizePx,
    selectedBlockCount,
    setFontFamilyDraft,
  } = props;
  const model = resolveEditorPanelModel(block, resolvedFontSizePx);
  const mixedFields = React.useMemo<ReadonlySet<PanelFormatFieldKey>>(
    () => new Set(formatSelection.mixedFields),
    [formatSelection.mixedFields],
  );
  return (
    <>
      <EditorStylePresetControls props={props} />
      <FormatEditorGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        fontFamilyDraft={fontFamilyDraft}
        mixedFields={mixedFields}
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
        mixedFields={mixedFields}
        model={model}
        onUpdate={onUpdate}
      />
      <EditorTextEffectGroup
        block={block}
        disabled={disabled}
        mixedFields={mixedFields}
        onUpdate={onUpdate}
      />
      <BlockDisplayGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        mixed={mixedFields.has("opacity")}
        onApply={onApplyBlockBackgroundOpacity}
        onUpdate={onUpdate}
      />
    </>
  );
}

function EditorStylePresetControls({
  props,
}: {
  props: EditorFormatGroupsProps;
}): React.JSX.Element | null {
  if (props.showStylePresets === false) return null;
  return (
    <BlockStylePresetControls
      activePresetId={props.activeStylePresetId}
      canCreate={props.canCreateStylePreset}
      disabled={props.disabled}
      presets={props.stylePresets}
      onApply={props.onApplyStylePreset}
      onCreate={props.onCreateStylePreset}
      onDelete={props.onDeleteStylePreset}
      onManage={props.onOpenStylePresetManager}
      onOverwrite={props.onOverwriteStylePreset}
      onRename={props.onRenameStylePreset}
    />
  );
}
