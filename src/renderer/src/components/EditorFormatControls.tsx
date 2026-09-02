import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import { resolveBlockTextWordBreak } from "../../../shared/textWrapping";
import { BlockSpacingFields } from "./BlockSpacingFields";
import { BlockTextOpacityField } from "./BlockTextOpacityField";
import { FontSelect } from "./FontSelect";
import { FormatBatchApplyModal } from "./FormatBatchApplyModal";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { SegmentedControl } from "./ui/SegmentedControl";
import { TextWrappingSelect } from "./TextWrappingSelect";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  EmphasisMarkIcon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "./ui/icons";
import type { EditorPanelModel } from "./editorPanelUtils";
import { EditorFontSizeRow } from "./EditorFontSizeRow";

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
  onOpenFontManager,
  onUpdate,
  selectedBlockCount,
}: BlockSectionProps & {
  disableChapterApply: boolean;
  fontFamilyDraft?: string;
  model: EditorPanelModel;
  onApplyFormat?: ApplyFormatHandler;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onFontFamilyDraftChange: (fontFamily?: string) => void;
  onOpenFontManager?: () => void;
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
      <BatchApplyDialog
        disableChapterApply={disableChapterApply}
        onApply={onApplyFormat}
        onClose={() => setApplyOpen(false)}
        open={applyOpen}
        selectedBlockCount={selectedBlockCount}
      />
      <StyleToolbar {...{ block, disabled, model, onUpdate }} />
      <FontField
        disabled={disabled}
        fontFamilyDraft={fontFamilyDraft}
        onFontFamilyDraftChange={onFontFamilyDraftChange}
        onOpenFontManager={onOpenFontManager}
        onUpdate={onUpdate}
      />
      <TextWrappingField {...{ block, disabled, onUpdate }} />
      <div className="editor-format-fields">
        <EditorFontSizeRow
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

function BatchApplyDialog({
  disableChapterApply,
  onApply,
  onClose,
  open,
  selectedBlockCount,
}: {
  disableChapterApply: boolean;
  onApply?: ApplyFormatHandler;
  onClose: () => void;
  open: boolean;
  selectedBlockCount: number;
}): React.JSX.Element | null {
  if (!open || !onApply) return null;
  return (
    <FormatBatchApplyModal
      selectedBlockCount={selectedBlockCount}
      disableChapterApply={disableChapterApply}
      onApply={onApply}
      onClose={onClose}
    />
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
    <div
      className="format-emphasis-control"
      role="group"
      aria-label={t("format.blockStyle", { defaultValue: "블록 전체" })}
    >
      <div className="block-style-group">
        <IconButton
          size="sm"
          label={t("format.blockBold", { defaultValue: "블록 전체 굵게" })}
          aria-pressed={Boolean(block.bold)}
          disabled={disabled}
          onClick={() => onUpdate({ bold: !block.bold })}
        >
          <BoldIcon size={18} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("format.blockItalic", {
            defaultValue: "블록 전체 기울임",
          })}
          aria-pressed={Boolean(block.italic)}
          disabled={disabled}
          onClick={() => onUpdate({ italic: !block.italic })}
        >
          <ItalicIcon size={18} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("format.blockUnderline", {
            defaultValue: "블록 전체 밑줄",
          })}
          aria-pressed={Boolean(block.underline)}
          disabled={disabled}
          onClick={() => onUpdate({ underline: !block.underline })}
        >
          <UnderlineIcon size={18} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("format.blockStrikethrough", {
            defaultValue: "블록 전체 취소선",
          })}
          aria-pressed={Boolean(block.strikethrough)}
          disabled={disabled}
          onClick={() => onUpdate({ strikethrough: !block.strikethrough })}
        >
          <StrikethroughIcon size={18} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("format.blockEmphasisMark", {
            defaultValue: "블록 전체 강조점",
          })}
          aria-pressed={Boolean(block.emphasisMark)}
          disabled={disabled}
          onClick={() => onUpdate({ emphasisMark: !block.emphasisMark })}
        >
          <EmphasisMarkIcon size={18} />
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
        size="sm"
        label={t("format.align.left")}
        title={t("format.align.left")}
        aria-pressed={block.textAlign === "left"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "left" })}
      >
        <AlignLeftIcon size={18} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("format.align.center")}
        title={t("format.align.center")}
        aria-pressed={block.textAlign === "center"}
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "center" })}
      >
        <AlignCenterIcon size={18} />
      </IconButton>
      <IconButton
        size="sm"
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
    <SegmentedControl
      ariaLabel={t("format.directionLabel")}
      className="editor-direction-toggle"
      disabled={disabled}
      singleRow
      options={[
        { id: "horizontal", label: t("format.direction.horizontal") },
        { id: "vertical", label: t("format.direction.vertical") },
      ]}
      value={renderDirection}
      onChange={(nextDirection) => onUpdate({ renderDirection: nextDirection })}
    />
  );
}

function FontField({
  disabled,
  fontFamilyDraft,
  onFontFamilyDraftChange,
  onOpenFontManager,
  onUpdate,
}: {
  disabled: boolean;
  fontFamilyDraft?: string;
  onFontFamilyDraftChange: (fontFamily?: string) => void;
  onOpenFontManager?: () => void;
  onUpdate: BlockPatchHandler;
}): React.JSX.Element {
  return (
    <div className="font-field">
      <FontSelect
        value={fontFamilyDraft}
        disabled={disabled}
        onOpenManager={onOpenFontManager}
        onChange={(fontFamily) => {
          onFontFamilyDraftChange(fontFamily);
          onUpdate({ fontFamily });
        }}
      />
    </div>
  );
}
