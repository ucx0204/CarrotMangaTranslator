import React from "react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type { PanelFormatFieldKey } from "../../../shared/panelBridgeTypes";
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
  mixedFields: ReadonlySet<PanelFormatFieldKey>;
  onUpdate: BlockPatchHandler;
};

export function FormatEditorGroup({
  block,
  disabled,
  disableChapterApply,
  fontFamilyDraft,
  mixedFields,
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
      <StyleToolbar {...{ block, disabled, mixedFields, model, onUpdate }} />
      <FontField
        disabled={disabled}
        fontFamilyDraft={fontFamilyDraft}
        mixed={mixedFields.has("fontFamily")}
        onFontFamilyDraftChange={onFontFamilyDraftChange}
        onOpenFontManager={onOpenFontManager}
        onUpdate={onUpdate}
      />
      <TextWrappingField {...{ block, disabled, mixedFields, onUpdate }} />
      <FormatNumberFields
        block={block}
        disabled={disabled}
        mixedFields={mixedFields}
        model={model}
        onAdjustFontSize={onAdjustFontSize}
        onUpdate={onUpdate}
      />
    </div>
  );
}

function FormatNumberFields({
  block,
  disabled,
  mixedFields,
  model,
  onAdjustFontSize,
  onUpdate,
}: BlockSectionProps & {
  model: EditorPanelModel;
  onAdjustFontSize: (adjustment: -1 | 1) => void;
}): React.JSX.Element {
  return (
    <div className="editor-format-fields">
      <EditorFontSizeRow
        autoFitText={model.autoFitText}
        autoFitMixed={mixedFields.has("autoFitText")}
        disabled={disabled}
        fontSizePx={model.fontSizePx}
        fontSizeMixed={mixedFields.has("fontSizePx")}
        onAdjust={onAdjustFontSize}
        onUpdate={onUpdate}
      />
      <div className="editor-format-number-grid">
        <BlockTextOpacityField
          block={block}
          disabled={disabled}
          mixed={mixedFields.has("textOpacity")}
          onUpdate={onUpdate}
        />
        <BlockSpacingFields
          block={block}
          disabled={disabled}
          mixedFields={mixedFields}
          onUpdate={onUpdate}
        />
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
  mixedFields,
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
        mixed={mixedFields.has("wordBreak")}
        onChange={(wordBreak) => onUpdate({ wordBreak })}
      />
    </label>
  );
}

function StyleToolbar({
  block,
  disabled,
  mixedFields,
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
        mixedFields={mixedFields}
        onUpdate={onUpdate}
      />
      <TextAlignButtons
        block={block}
        disabled={disabled}
        mixedFields={mixedFields}
        onUpdate={onUpdate}
      />
      <DirectionToggle
        disabled={disabled}
        mixed={mixedFields.has("renderDirection")}
        onUpdate={onUpdate}
        renderDirection={model.renderDirection}
      />
    </div>
  );
}

function TextEmphasisButtons({
  block,
  disabled,
  mixedFields,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const controls = [
    {
      field: "bold",
      label: t("format.blockBold", { defaultValue: "블록 전체 굵게" }),
      icon: <BoldIcon size={18} />,
    },
    {
      field: "italic",
      label: t("format.blockItalic", { defaultValue: "블록 전체 기울임" }),
      icon: <ItalicIcon size={18} />,
    },
    {
      field: "underline",
      label: t("format.blockUnderline", { defaultValue: "블록 전체 밑줄" }),
      icon: <UnderlineIcon size={18} />,
    },
    {
      field: "strikethrough",
      label: t("format.blockStrikethrough", {
        defaultValue: "블록 전체 취소선",
      }),
      icon: <StrikethroughIcon size={18} />,
    },
    {
      field: "emphasisMark",
      label: t("format.blockEmphasisMark", {
        defaultValue: "블록 전체 강조점",
      }),
      icon: <EmphasisMarkIcon size={18} />,
    },
  ] as const;
  return (
    <div
      className="format-emphasis-control"
      role="group"
      aria-label={t("format.blockStyle", { defaultValue: "블록 전체" })}
    >
      <div className="block-style-group">
        {controls.map(({ field, icon, label }) => (
          <IconButton
            key={field}
            size="sm"
            label={label}
            aria-pressed={
              mixedFields.has(field) ? "mixed" : Boolean(block[field])
            }
            disabled={disabled}
            onClick={() =>
              onUpdate({
                [field]: mixedFields.has(field) || !block[field],
              })
            }
          >
            {icon}
          </IconButton>
        ))}
      </div>
    </div>
  );
}

function TextAlignButtons({
  block,
  disabled,
  mixedFields,
  onUpdate,
}: BlockSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="block-style-group">
      <IconButton
        size="sm"
        label={t("format.align.left")}
        title={t("format.align.left")}
        aria-pressed={
          !mixedFields.has("textAlign") && block.textAlign === "left"
        }
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "left" })}
      >
        <AlignLeftIcon size={18} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("format.align.center")}
        title={t("format.align.center")}
        aria-pressed={
          !mixedFields.has("textAlign") && block.textAlign === "center"
        }
        disabled={disabled}
        onClick={() => onUpdate({ textAlign: "center" })}
      >
        <AlignCenterIcon size={18} />
      </IconButton>
      <IconButton
        size="sm"
        label={t("format.align.right")}
        title={t("format.align.right")}
        aria-pressed={
          !mixedFields.has("textAlign") && block.textAlign === "right"
        }
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
  mixed,
  onUpdate,
  renderDirection,
}: {
  disabled: boolean;
  mixed: boolean;
  onUpdate: BlockPatchHandler;
  renderDirection: EditorPanelModel["renderDirection"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <SegmentedControl
      ariaLabel={t("format.directionLabel")}
      className="editor-direction-toggle"
      disabled={disabled}
      mixed={mixed}
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
  mixed,
  onFontFamilyDraftChange,
  onOpenFontManager,
  onUpdate,
}: {
  disabled: boolean;
  fontFamilyDraft?: string;
  mixed: boolean;
  onFontFamilyDraftChange: (fontFamily?: string) => void;
  onOpenFontManager?: () => void;
  onUpdate: BlockPatchHandler;
}): React.JSX.Element {
  return (
    <div className="font-field">
      <FontSelect
        value={fontFamilyDraft}
        disabled={disabled}
        mixed={mixed}
        onOpenManager={onOpenFontManager}
        onChange={(fontFamily) => {
          onFontFamilyDraftChange(fontFamily);
          onUpdate({ fontFamily });
        }}
      />
    </div>
  );
}
