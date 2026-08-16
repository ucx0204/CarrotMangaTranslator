import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import { resolveBlockTextWordBreak } from "../../../shared/textWrapping";
import {
  FONT_SIZE_STEP_PX,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
} from "../../../shared/blockFormatValues";
import { BlockSpacingFields } from "./BlockSpacingFields";
import { FontSelect } from "./FontSelect";
import { FormatBatchApplyModal } from "./FormatBatchApplyModal";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { IconButton } from "./ui/IconButton";
import { ScrubbableNumberField } from "./ui/ScrubbableNumberField";
import { TextWrappingSelect } from "./TextWrappingSelect";
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
      <TextWrappingField {...{ block, disabled, onUpdate }} />
      <div className="editor-format-fields">
        <FontSizeRow
          autoFitText={model.autoFitText}
          disabled={disabled}
          fontSizePx={model.fontSizePx}
          onAdjust={onAdjustFontSize}
          onUpdate={onUpdate}
        />
        <div className="editor-format-number-grid">
          <BlockTextOpacityField
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
      </div>
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
    <div className="editor-font-size-row">
      <div className="editor-format-number-cell">
        <span>{t("format.size")}</span>
        <ScrubbableNumberField
          className="font-size-stepper"
          inputClassName="font-size-number"
          ariaLabel={t("format.fontSizeValue")}
          decreaseLabel={t("format.fontSizeDecrease")}
          increaseLabel={t("format.fontSizeIncrease")}
          min={MIN_FONT_SIZE_PX}
          max={MAX_FONT_SIZE_PX}
          step={FONT_SIZE_STEP_PX}
          precision={1}
          value={fontSizePx}
          disabled={disabled}
          inputDisabled={autoFitText}
          scrubDisabled={autoFitText}
          unit="px"
          onStep={onAdjust}
          onValueChange={updateFontSize}
        />
      </div>
      <CheckboxField
        className="inline-toggle editor-font-size-auto"
        title={t("format.autoFitTitle")}
        label={t("format.auto")}
        checked={autoFitText}
        disabled={disabled}
        onCheckedChange={(checked) => onUpdate({ autoFitText: checked })}
      />
    </div>
  );
}

function BlockTextOpacityField({
  block,
  disabled,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const label = t("format.textOpacity");
  return (
    <div className="editor-format-number-cell">
      <span>{label}</span>
      <ScrubbableNumberField
        ariaLabel={label}
        decreaseLabel={t("format.decreaseValue", { label })}
        increaseLabel={t("format.increaseValue", { label })}
        min={0}
        max={100}
        step={1}
        precision={0}
        value={Math.round((block.textOpacity ?? 1) * 100)}
        disabled={disabled}
        unit="%"
        onValueChange={(value) => onUpdate({ textOpacity: value / 100 })}
      />
    </div>
  );
}
