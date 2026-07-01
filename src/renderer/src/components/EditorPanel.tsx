import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import { normalizeRenderDirection } from "../../../shared/geometry";
import type { FormatApplyScope } from "../hooks/useBlockEditingActions";
import {
  BlockActionButtons,
  ColorEditorGroup,
  EmptyEditorPanel,
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
      <header className="editor-panel-header">
        <h2>블록</h2>
        {headerActions ? (
          <div className="editor-panel-header-actions">{headerActions}</div>
        ) : null}
      </header>
      <TextEditorGroup block={block} disabled={disabled} onUpdate={onUpdate} />
      <FormatEditorGroup
        block={block}
        disabled={disabled}
        disableChapterApply={disableChapterApply}
        fontFamilyDraft={fontFamilyDraft}
        model={model}
        onApplyFormat={onApplyFormat}
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
      <BlockActionButtons
        disabled={disabled}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
      />
    </section>
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
