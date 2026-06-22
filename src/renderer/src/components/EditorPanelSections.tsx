import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import { ColorField } from "./ColorField";
import { useStickyTextareaHeight } from "../hooks/useStickyTextareaHeight";
import { Button, FieldSlider, IconButton } from "./ui";
import { CopyIcon, RestoreIcon, TrashIcon } from "./ui/icons";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";

type BlockPatchHandler = (patch: Partial<TranslationBlock>) => void;

type BlockSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: BlockPatchHandler;
};

export function EmptyEditorPanel({
  areaTranslateAvailable,
  areaTranslateSelecting,
  disabled,
  onStartAreaTranslate,
}: {
  areaTranslateAvailable: boolean;
  areaTranslateSelecting: boolean;
  disabled: boolean;
  onStartAreaTranslate?: () => void;
}): React.JSX.Element {
  return (
    <section className="editor-panel muted">
      <h2>블록</h2>
      <button
        className={`area-translate-button ${areaTranslateSelecting ? "active" : ""}`}
        disabled={disabled || !areaTranslateAvailable}
        onClick={onStartAreaTranslate}
      >
        {areaTranslateSelecting ? "선택 취소" : "영역 번역"}
      </button>
    </section>
  );
}

export function TextEditorGroup({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { refCallback: translatedTextareaRef, reset: resetTranslatedHeight } =
    useStickyTextareaHeight("editor.textareaHeight.translated");
  const { refCallback: sourceTextareaRef, reset: resetSourceHeight } =
    useStickyTextareaHeight("editor.textareaHeight.source");
  const resetTextareaHeights = React.useCallback(() => {
    resetTranslatedHeight();
    resetSourceHeight();
  }, [resetTranslatedHeight, resetSourceHeight]);

  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>텍스트</h3>
        <IconButton
          size="sm"
          label="입력칸 높이 초기화"
          title="입력칸 높이 초기화"
          onClick={resetTextareaHeights}
        >
          <RestoreIcon size={14} />
        </IconButton>
      </div>
      <label>
        한국어
        <textarea
          ref={translatedTextareaRef}
          value={block.translatedText}
          disabled={disabled}
          onChange={(event) => onUpdate({ translatedText: event.target.value })}
        />
      </label>
      <label>
        OCR
        <textarea
          ref={sourceTextareaRef}
          value={block.sourceText}
          disabled={disabled}
          onChange={(event) => onUpdate({ sourceText: event.target.value })}
        />
      </label>
    </div>
  );
}

export function ColorEditorGroup({
  block,
  disabled,
  model,
  onUpdate,
}: BlockSectionProps & {
  model: EditorPanelModel;
}): React.JSX.Element {
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>색상</h3>
      </div>
      <div className="color-row" aria-label="블록 색상">
        <ColorField
          label="글자색"
          value={resolveColor(block.textColor, "#111111")}
          disabled={disabled}
          onChange={(textColor) => onUpdate({ textColor })}
        />
        <ColorField
          label="외곽선"
          value={model.outlineColor}
          disabled={disabled}
          onChange={(outlineColor) => onUpdate({ outlineColor })}
        />
      </div>
      <FieldSlider
        label="외곽선"
        valueLabel={`${Math.round((block.outlineWidthScale ?? 1) * 100)}%`}
        min={0}
        max={2.5}
        step={0.1}
        value={block.outlineWidthScale ?? 1}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({ outlineWidthScale: Number(event.target.value) })
        }
      />
    </div>
  );
}

export function BlockActionButtons({
  disabled,
  onDelete,
  onDuplicate,
}: {
  disabled: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
}): React.JSX.Element {
  return (
    <div className="block-actions">
      <Button
        fullWidth
        iconLeft={<CopyIcon size={15} />}
        onClick={onDuplicate}
        disabled={disabled}
      >
        복제
      </Button>
      <Button
        variant="danger"
        fullWidth
        iconLeft={<TrashIcon size={15} />}
        onClick={onDelete}
        disabled={disabled}
      >
        삭제
      </Button>
    </div>
  );
}
