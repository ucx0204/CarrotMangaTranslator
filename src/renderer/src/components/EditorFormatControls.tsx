import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("components");
  const [applyOpen, setApplyOpen] = React.useState(false);
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("format.title")}</h3>
        {onApplyFormat ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setApplyOpen(true)}
            title={t("format.batchApplyTitle")}
          >
            {t("format.batchApply")}
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
  const { t } = useTranslation("components");
  return (
    <div className="block-style-group">
      <IconButton
        label={t("format.bold")}
        title={t("format.bold")}
        aria-pressed={Boolean(block.bold)}
        disabled={disabled}
        onClick={() => onUpdate({ bold: !block.bold })}
      >
        <BoldIcon size={18} />
      </IconButton>
      <IconButton
        label={t("format.italic")}
        title={t("format.italic")}
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
  const { t } = useTranslation("components");
  return (
    <div className="block-style-group">
      <IconButton
        label={t("format.align.left")}
        title={t("format.align.left")}
        aria-pressed={block.textAlign === "left"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "left" })}
      >
        <AlignLeftIcon size={18} />
      </IconButton>
      <IconButton
        label={t("format.align.center")}
        title={t("format.align.center")}
        aria-pressed={block.textAlign === "center"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "center" })}
      >
        <AlignCenterIcon size={18} />
      </IconButton>
      <IconButton
        label={t("format.align.right")}
        title={t("format.align.right")}
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
  const { t } = useTranslation("components");
  return (
    <div className="dir-toggle">
      <button
        type="button"
        aria-pressed={renderDirection === "horizontal"}
        disabled={disabled}
        onClick={() => onUpdate({ renderDirection: "horizontal" })}
      >
        {t("format.direction.horizontal")}
      </button>
      <button
        type="button"
        aria-pressed={renderDirection === "vertical"}
        disabled={disabled}
        onClick={() => onUpdate({ renderDirection: "vertical" })}
      >
        {t("format.direction.vertical")}
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
  const { t } = useTranslation("components");
  const updateFontSize = (value: number) =>
    onUpdate({ fontSizePx: clampFontSize(value), autoFitText: false });
  return (
    <div className="font-size-row">
      <span className="font-size-label">{t("format.size")}</span>
      <RangeInput
        aria-label={t("format.fontSize")}
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
        aria-label={t("format.fontSizeValue")}
        min={10}
        max={160}
        step={1}
        value={fontSizePx}
        disabled={disabled || autoFitText}
        onChange={(event) => updateFontSize(Number(event.target.value))}
      />
      <label className="inline-toggle" title={t("format.autoFitTitle")}>
        <input
          type="checkbox"
          checked={autoFitText}
          disabled={disabled}
          onChange={(event) => onUpdate({ autoFitText: event.target.checked })}
        />
        {t("format.auto")}
      </label>
    </div>
  );
}

function BlockTransformSliders({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <FieldSlider
        label={t("format.rotation")}
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
        label={t("format.opacity")}
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
