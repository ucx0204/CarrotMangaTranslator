import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { normalizeRenderDirection } from "../../../shared/geometry";
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
  disableChapterFontApply?: boolean;
  onStartAreaTranslate?: () => void;
  onApplyFont?: (scope: "page" | "chapter", fontFamily?: string) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
};

export function EditorPanel({
  block,
  disabled,
  areaTranslateAvailable = false,
  areaTranslateSelecting = false,
  disableChapterFontApply = false,
  onStartAreaTranslate,
  onApplyFont,
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
        onStartAreaTranslate={onStartAreaTranslate}
      />
    );
  }

  const model = resolveEditorPanelModel(block);
  return (
    <section className="editor-panel has-block">
      <h2>블록</h2>
      <TextEditorGroup block={block} disabled={disabled} onUpdate={onUpdate} />
      <FormatEditorGroup
        block={block}
        disabled={disabled}
        disableChapterFontApply={disableChapterFontApply}
        fontFamilyDraft={fontFamilyDraft}
        model={model}
        onApplyFont={onApplyFont}
        onFontFamilyDraftChange={setFontFamilyDraft}
        onUpdate={onUpdate}
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
