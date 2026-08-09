import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import { resolveBlockTextWordBreak } from "../../../shared/textWrapping";
import { BlockSpacingFields } from "./BlockSpacingFields";
import { FontSizeNumberInput } from "./FontSizeNumberInput";
import { FontSelect } from "./FontSelect";
import { FormatBatchApplyModal } from "./FormatBatchApplyModal";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { FieldSlider, FieldSliderGroup } from "./ui/FieldSlider";
import { IconButton } from "./ui/IconButton";
import { RangeInput } from "./ui/Field";
import { TextWrappingSelect } from "./TextWrappingSelect";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  ItalicIcon,
} from "./ui/icons";
import { clampFontSize, type EditorPanelModel } from "./editorPanelUtils";
import { AutomaticFontMatchNotice } from "./AutomaticFontMatchNotice";

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
  onAdjustFontSize,
  onFontFamilyDraftChange,
  onUpdate,
  selectedBlockCount,
}: BlockSectionProps & {
  disableChapterApply: boolean;
  fontFamilyDraft?: string;
  model: EditorPanelModel;
  onApplyFormat?: ApplyFormatHandler;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
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
      <StyleToolbar {...{ block, disabled, model, onUpdate }} />
      <FontField
        disabled={disabled}
        fontFamilyDraft={fontFamilyDraft}
        onFontFamilyDraftChange={onFontFamilyDraftChange}
        onUpdate={onUpdate}
      />
      <AutomaticFontMatchNotice {...{ block, disabled, onUpdate }} />
      <TextWrappingField {...{ block, disabled, onUpdate }} />
      <FieldSliderGroup>
        <FontSizeRow
          autoFitText={model.autoFitText}
          disabled={disabled}
          fontSizePx={model.fontSizePx}
          onAdjust={onAdjustFontSize}
          onUpdate={onUpdate}
        />
        <BlockTextOpacitySlider
          block={block}
          disabled={disabled}
          onUpdate={onUpdate}
        />
        <BlockSpacingFields
          block={block}
          disabled={disabled}
          onUpdate={onUpdate}
        />
      </FieldSliderGroup>
    </div>
  );
}

function TextWrappingField({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label className="editor-word-break-field">
      <span>{t("format.wordBreak.label")}</span>
      <TextWrappingSelect
        ariaLabel={t("format.wordBreak.label")}
        value={resolveBlockTextWordBreak(
          block.wordBreak,
          block.renderDirection,
        )}
        disabled={disabled}
        onChange={(wordBreak) => onUpdate({ wordBreak })}
      />
    </label>
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
    <div className="format-emphasis-control">
      <span className="format-toolbar-label">
        {t("format.blockStyle", { defaultValue: "블록 전체" })}
      </span>
      <div className="block-style-group">
        <IconButton
          label={t("format.blockBold", { defaultValue: "블록 전체 굵게" })}
          title={t("format.blockBold", { defaultValue: "블록 전체 굵게" })}
          aria-pressed={Boolean(block.bold)}
          disabled={disabled}
          onClick={() => onUpdate({ bold: !block.bold })}
        >
          <BoldIcon size={18} />
        </IconButton>
        <IconButton
          label={t("format.blockItalic", {
            defaultValue: "블록 전체 기울임",
          })}
          title={t("format.blockItalic", {
            defaultValue: "블록 전체 기울임",
          })}
          aria-pressed={Boolean(block.italic)}
          disabled={disabled}
          onClick={() => onUpdate({ italic: !block.italic })}
        >
          <ItalicIcon size={18} />
        </IconButton>
      </div>
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
  onAdjust,
  onUpdate,
}: {
  autoFitText: boolean;
  disabled: boolean;
  fontSizePx: number;
  onAdjust: (adjustment: -1 | 1) => void;
  onUpdate: BlockPatchHandler;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const updateFontSize = (value: number) =>
    onUpdate({ fontSizePx: clampFontSize(value), autoFitText: false });
  return (
    <div className="font-size-row editor-font-size-row">
      <span className="font-size-label">{t("format.size")}</span>
      <div className="font-size-stepper">
        <IconButton
          className="font-size-adjust-button"
          size="sm"
          label={t("format.fontSizeDecrease")}
          disabled={disabled || (!autoFitText && fontSizePx <= 10)}
          onClick={() => onAdjust(-1)}
        >
          <span aria-hidden="true">−</span>
        </IconButton>
        <FontSizeNumberInput
          className="font-size-number"
          ariaLabel={t("format.fontSizeValue")}
          min={10}
          max={160}
          value={fontSizePx}
          disabled={disabled || autoFitText}
          onValueChange={updateFontSize}
        />
        <IconButton
          className="font-size-adjust-button"
          size="sm"
          label={t("format.fontSizeIncrease")}
          disabled={disabled || (!autoFitText && fontSizePx >= 160)}
          onClick={() => onAdjust(1)}
        >
          <span aria-hidden="true">+</span>
        </IconButton>
      </div>
      <CheckboxField
        className="inline-toggle"
        title={t("format.autoFitTitle")}
        label={t("format.auto")}
        checked={autoFitText}
        disabled={disabled}
        onCheckedChange={(checked) => onUpdate({ autoFitText: checked })}
      />
      <RangeInput
        className="font-size-slider"
        aria-label={t("format.fontSize")}
        min={10}
        max={160}
        step={1}
        value={fontSizePx}
        disabled={disabled || autoFitText}
        onChange={(event) => updateFontSize(Number(event.target.value))}
      />
    </div>
  );
}

function BlockTextOpacitySlider({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <FieldSlider
      label={t("format.textOpacity")}
      valueLabel={`${Math.round((block.textOpacity ?? 1) * 100)}%`}
      min={0}
      max={1}
      step={0.01}
      value={block.textOpacity ?? 1}
      disabled={disabled}
      onChange={(event) =>
        onUpdate({ textOpacity: Number(event.target.value) })
      }
    />
  );
}
