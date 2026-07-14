import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import { normalizeRenderDirection } from "../../../shared/geometry";
import type {
  BlockBackgroundApplyScope,
  FormatApplyScope,
} from "../hooks/useBlockEditingActions";
import {
  BlockActionButtons,
  BlockDisplayGroup,
  ColorEditorGroup,
  EmptyEditorPanel,
  InpaintingBlockOption,
  TextEditorGroup,
} from "./EditorPanelSections";
import { FormatEditorGroup } from "./EditorFormatControls";
import {
  clampFontSize,
  resolveColor,
  type EditorPanelModel,
} from "./editorPanelUtils";

type EditorPanelProps = {
  block: TranslationBlock | null;
  disabled: boolean;
  areaTranslateAvailable?: boolean;
  areaTranslateSelecting?: boolean;
  disableChapterApply?: boolean;
  selectedBlockCount?: number;
  /** Optional actions (e.g. float/dock toggle) rendered in the panel header. */
  headerActions?: React.ReactNode;
  onStartAreaTranslate?: () => void;
  onApplyFormat?: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onApplyBlockBackgroundOpacity?: (scope: BlockBackgroundApplyScope) => void;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

export function EditorPanel({
  block,
  disabled,
  areaTranslateAvailable = false,
  areaTranslateSelecting = false,
  disableChapterApply = false,
  selectedBlockCount = 0,
  headerActions,
  onStartAreaTranslate,
  onApplyFormat,
  onApplyBlockBackgroundOpacity,
  onAdjustFontSize,
  onUpdate,
  onDelete,
  onDuplicate,
}: EditorPanelProps): React.JSX.Element {
  const [fontFamilyDraft, setFontFamilyDraft] = React.useState<
    string | undefined
  >(block?.fontFamily);

  React.useEffect(() => {
    setFontFamilyDraft(block?.fontFamily);
  }, [block?.id, block?.fontFamily]);

  if (!block) {
    return (
      <EmptyEditorPanel
        areaTranslateAvailable={areaTranslateAvailable}
        areaTranslateSelecting={areaTranslateSelecting}
        disabled={disabled}
        headerActions={headerActions}
        onStartAreaTranslate={onStartAreaTranslate}
      />
    );
  }

  const model = resolveEditorPanelModel(block);
  return (
    <section className="editor-panel has-block">
      <EditorPanelHeader actions={headerActions} />
      <InpaintingBlockOption
        block={block}
        disabled={disabled}
        onUpdate={onUpdate}
      />
      <TextEditorGroup block={block} disabled={disabled} onUpdate={onUpdate} />
      <FormatEditorGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        fontFamilyDraft={fontFamilyDraft}
        model={model}
        onApplyFormat={onApplyFormat}
        onAdjustFontSize={onAdjustFontSize}
        onFontFamilyDraftChange={setFontFamilyDraft}
        onUpdate={onUpdate}
        selectedBlockCount={selectedBlockCount}
      />
      <ColorEditorGroup
        block={block}
        disabled={disabled}
        model={model}
        onUpdate={onUpdate}
      />
      <BlockDisplayGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        onApply={onApplyBlockBackgroundOpacity}
        onUpdate={onUpdate}
      />
      <BlockActionButtons
        disabled={disabled}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
      />
    </section>
  );
}

function EditorPanelHeader({
  actions,
}: {
  actions?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <header className="editor-panel-header">
      <h2>{t("common.blocks")}</h2>
      {actions ? (
        <div className="editor-panel-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}

function resolveEditorPanelModel(block: TranslationBlock): EditorPanelModel {
  return {
    autoFitText: block.autoFitText ?? true,
    fontSizePx: clampFontSize(block.fontSizePx),
    outlineColor: resolveColor(block.outlineColor, "#ffffff"),
    renderDirection: normalizeRenderDirection(
      block.renderDirection,
      "horizontal",
    ),
  };
}
