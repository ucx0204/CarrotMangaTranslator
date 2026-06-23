import React from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import { BlockSpacingFields } from "./BlockSpacingFields";
import { FontSelect } from "./FontSelect";
import { FormatBatchApplyModal } from "./FormatBatchApplyModal";
import type { FormatApplyScope } from "../hooks/useBlockEditingActions";
import { Button, FieldSlider, IconButton, RangeInput } from "./ui";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "./ui/icons";
import { clampFontSize, type EditorPanelModel } from "./editorPanelUtils";

type BlockPatchHandler = (patch: Partial<TranslationBlock>) => void;
type ApplyFormatHandler = (
  scope: FormatApplyScope,
  groupIds: BlockFormatGroupId[],
) => void;

type BlockSectionProps = {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: BlockPatchHandler;
};

export function FormatEditorGroup({
  block,
  disabled,
  disableChapterApply,
  fontFamilyDraft,
  model,
  onApplyFormat,
  onFontFamilyDraftChange,
  onUpdate,
  selectedBlockCount,
}: BlockSectionProps & {
  disableChapterApply: boolean;
  fontFamilyDraft?: string;
  model: EditorPanelModel;
  onApplyFormat?: ApplyFormatHandler;
  onFontFamilyDraftChange: (fontFamily?: string) => void;
  selectedBlockCount: number;
}): React.JSX.Element {
  const [applyOpen, setApplyOpen] = React.useState(false);
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>서식</h3>
        {onApplyFormat ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setApplyOpen(true)}
            title="이 블록의 서식을 다른 블록에 일괄 적용"
          >
            일괄 적용
          </Button>
        ) : null}
      </div>
      {applyOpen && onApplyFormat ? (
        <FormatBatchApplyModal
          selectedBlockCount={selectedBlockCount}
          disableChapterApply={disableChapterApply}
          onApply={onApplyFormat}
          onClose={() => setApplyOpen(false)}
        />
      ) : null}
      <StyleToolbar
        block={block}
        disabled={disabled}
        model={model}
        onUpdate={onUpdate}
      />
      <FontField
        disabled={disabled}
        fontFamilyDraft={fontFamilyDraft}
        onFontFamilyDraftChange={onFontFamilyDraftChange}
        onUpdate={onUpdate}
      />
      <FontSizeRow
        autoFitText={model.autoFitText}
        disabled={disabled}
        fontSizePx={model.fontSizePx}
        onUpdate={onUpdate}
      />
      <BlockTransformSliders
        block={block}
        disabled={disabled}
        onUpdate={onUpdate}
      />
      <BlockSpacingFields
        block={block}
        disabled={disabled}
        onUpdate={onUpdate}
      />
    </div>
  );
}

function StyleToolbar({
  block,
  disabled,
  model,
  onUpdate,
}: BlockSectionProps & {
  model: EditorPanelModel;
}): React.JSX.Element {
  return (
    <div className="format-toolbar">
      <TextEmphasisButtons
        block={block}
        disabled={disabled}
        onUpdate={onUpdate}
      />
      <TextAlignButtons block={block} disabled={disabled} onUpdate={onUpdate} />
      <DirectionToggle
        disabled={disabled}
        onUpdate={onUpdate}
        renderDirection={model.renderDirection}
      />
    </div>
  );
}

function TextEmphasisButtons({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  return (
    <div className="block-style-group">
      <IconButton
        label="굵게"
        title="굵게"
        aria-pressed={Boolean(block.bold)}
        disabled={disabled}
        onClick={() => onUpdate({ bold: !block.bold })}
      >
        <BoldIcon size={18} />
      </IconButton>
      <IconButton
        label="기울임꼴"
        title="기울임꼴"
        aria-pressed={Boolean(block.italic)}
        disabled={disabled}
        onClick={() => onUpdate({ italic: !block.italic })}
      >
        <ItalicIcon size={18} />
      </IconButton>
    </div>
  );
}

function TextAlignButtons({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  return (
    <div className="block-style-group">
      <IconButton
        label="왼쪽 정렬"
        title="왼쪽 정렬"
        aria-pressed={block.textAlign === "left"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "left" })}
      >
        <AlignLeftIcon size={18} />
      </IconButton>
      <IconButton
        label="가운데 정렬"
        title="가운데 정렬"
        aria-pressed={block.textAlign === "center"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "center" })}
      >
        <AlignCenterIcon size={18} />
      </IconButton>
      <IconButton
        label="오른쪽 정렬"
        title="오른쪽 정렬"
        aria-pressed={block.textAlign === "right"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "right" })}
      >
        <AlignRightIcon size={18} />
      </IconButton>
    </div>
  );
}

function DirectionToggle({
  disabled,
  onUpdate,
  renderDirection,
}: {
  disabled: boolean;
  onUpdate: BlockPatchHandler;
  renderDirection: EditorPanelModel["renderDirection"];
}): React.JSX.Element {
  return (
    <div className="dir-toggle">
      <button
        type="button"
        aria-pressed={renderDirection === "horizontal"}
        disabled={disabled}
        onClick={() => onUpdate({ renderDirection: "horizontal" })}
      >
        가로
      </button>
      <button
        type="button"
        aria-pressed={renderDirection === "vertical"}
        disabled={disabled}
        onClick={() => onUpdate({ renderDirection: "vertical" })}
      >
        세로
      </button>
    </div>
  );
}

function FontField({
  disabled,
  fontFamilyDraft,
  onFontFamilyDraftChange,
  onUpdate,
}: {
  disabled: boolean;
  fontFamilyDraft?: string;
  onFontFamilyDraftChange: (fontFamily?: string) => void;
  onUpdate: BlockPatchHandler;
}): React.JSX.Element {
  return (
    <div className="font-field">
      <FontSelect
        value={fontFamilyDraft}
        disabled={disabled}
        onChange={(fontFamily) => {
          onFontFamilyDraftChange(fontFamily);
          onUpdate({ fontFamily });
        }}
      />
    </div>
  );
}

function FontSizeRow({
  autoFitText,
  disabled,
  fontSizePx,
  onUpdate,
}: {
  autoFitText: boolean;
  disabled: boolean;
  fontSizePx: number;
  onUpdate: BlockPatchHandler;
}): React.JSX.Element {
  const updateFontSize = (value: number) =>
    onUpdate({ fontSizePx: clampFontSize(value), autoFitText: false });
  return (
    <div className="font-size-row">
      <span className="font-size-label">크기</span>
      <RangeInput
        aria-label="글자 크기"
        min={10}
        max={160}
        step={1}
        value={fontSizePx}
        disabled={disabled || autoFitText}
        onChange={(event) => updateFontSize(Number(event.target.value))}
      />
      <input
        className="font-size-number"
        type="number"
        aria-label="글자 크기 값"
        min={10}
        max={160}
        step={1}
        value={fontSizePx}
        disabled={disabled || autoFitText}
        onChange={(event) => updateFontSize(Number(event.target.value))}
      />
      <label className="inline-toggle" title="텍스트 상자에 맞춰 자동 크기">
        <input
          type="checkbox"
          checked={autoFitText}
          disabled={disabled}
          onChange={(event) => onUpdate({ autoFitText: event.target.checked })}
        />
        자동
      </label>
    </div>
  );
}

function BlockTransformSliders({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  return (
    <>
      <FieldSlider
        label="기울기"
        valueLabel={`${block.rotationDeg ?? 0}°`}
        min={-30}
        max={30}
        step={1}
        value={block.rotationDeg ?? 0}
        disabled={disabled}
        onChange={(event) =>
          onUpdate({ rotationDeg: Number(event.target.value) })
        }
      />
      <FieldSlider
        label="투명도"
        valueLabel={`${Math.round(block.opacity * 100)}%`}
        min={0.1}
        max={1}
        step={0.01}
        value={block.opacity}
        disabled={disabled}
        onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
      />
    </>
  );
}
