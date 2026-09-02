import React from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import {
  FONT_SIZE_STEP_PX,
  MAX_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
} from "../../../shared/blockFormatValues";
import { FontSelect } from "./FontSelect";
import { RichTranslationInlineNumberField } from "./RichTranslationInlineNumberField";
import type {
  RichTranslationEditorMode,
  RichTranslationInlineStyleAction,
  RichTranslationSelectionValues,
} from "./richTranslationEditorTypes";
import { IconButton } from "./ui/IconButton";
import {
  BoldIcon,
  EmphasisMarkIcon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "./ui/icons";

const MIN_INLINE_WIDTH_PERCENT = 10;
const MAX_INLINE_WIDTH_PERCENT = 500;

type RichTranslationInlineTypographyProps = {
  disabled: boolean;
  mode: RichTranslationEditorMode;
  values: RichTranslationSelectionValues;
  onApplyStyle: RichTranslationInlineStyleAction;
};

export function RichTranslationInlineTypography(
  props: RichTranslationInlineTypographyProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="rich-inline-style-grid">
      <InlineEmphasisTools {...props} />
      <RichTranslationInlineNumberField
        label={t("editor.richText.size", { defaultValue: "글자 크기" })}
        value={props.values.sizePx}
        min={MIN_FONT_SIZE_PX}
        max={MAX_FONT_SIZE_PX}
        step={FONT_SIZE_STEP_PX}
        precision={1}
        unit="px"
        mixed={props.values.sizeMixed}
        disabled={props.disabled}
        onChange={(sizePx) => props.onApplyStyle({ sizePx })}
      />
      <RichTranslationInlineNumberField
        label={t("editor.richText.opacity", {
          defaultValue: "글자 투명도",
        })}
        value={props.values.opacityPercent}
        min={0}
        max={100}
        step={1}
        precision={0}
        unit="%"
        mixed={props.values.opacityMixed}
        disabled={props.disabled}
        onChange={(opacity) => props.onApplyStyle({ opacity: opacity / 100 })}
      />
      <InlineWidthAndFontFields {...props} />
    </div>
  );
}

function InlineEmphasisTools({
  disabled,
  mode,
  onApplyStyle,
  values,
}: RichTranslationInlineTypographyProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const toggle = (
    key: "bold" | "italic" | "underline" | "strikethrough" | "emphasisMark",
    current: boolean,
  ): void => onApplyStyle({ [key]: mode === "visual" ? !current : true });
  const actions = [
    [
      "bold",
      values.bold,
      t("editor.markupToolbar.boldLabel"),
      t("editor.markupToolbar.boldTitle"),
      <BoldIcon size={14} />,
    ],
    [
      "italic",
      values.italic,
      t("editor.markupToolbar.italicLabel"),
      t("editor.markupToolbar.italicTitle"),
      <ItalicIcon size={14} />,
    ],
    [
      "underline",
      values.underline,
      t("format.blockUnderline"),
      t("format.blockUnderline"),
      <UnderlineIcon size={14} />,
    ],
    [
      "strikethrough",
      values.strikethrough,
      t("format.blockStrikethrough"),
      t("format.blockStrikethrough"),
      <StrikethroughIcon size={14} />,
    ],
    [
      "emphasisMark",
      values.emphasisMark,
      t("format.blockEmphasisMark"),
      t("format.blockEmphasisMark"),
      <EmphasisMarkIcon size={14} />,
    ],
  ] as const;
  return (
    <div className="rich-inline-emphasis-tools">
      {actions.map(([key, active, label, title, icon]) => (
        <IconButton
          key={key}
          size="sm"
          label={label}
          title={title}
          aria-pressed={active}
          disabled={disabled}
          onClick={() => toggle(key, active)}
        >
          {icon}
        </IconButton>
      ))}
    </div>
  );
}

function InlineWidthAndFontFields(
  props: RichTranslationInlineTypographyProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const fontLabel = t("editor.richText.font", { defaultValue: "글자 폰트" });
  return (
    <>
      <RichTranslationInlineNumberField
        label={t("format.fontWidth")}
        value={props.values.widthPercent}
        min={MIN_INLINE_WIDTH_PERCENT}
        max={MAX_INLINE_WIDTH_PERCENT}
        step={1}
        precision={0}
        unit="%"
        disabled={props.disabled}
        onChange={(width) => props.onApplyStyle({ widthScale: width / 100 })}
      />
      <div className="rich-inline-font-field">
        <span>
          {fontLabel}
          {props.values.fontMixed ? (
            <small>
              {t("editor.richText.mixed", { defaultValue: "혼합" })}
            </small>
          ) : null}
        </span>
        <FontSelect
          ariaLabel={fontLabel}
          value={props.values.fontFamily}
          disabled={props.disabled}
          onChange={(fontFamily) =>
            props.onApplyStyle({
              fontFamily:
                props.mode === "code" && fontFamily === undefined
                  ? DEFAULT_BLOCK_FONT_ID
                  : (fontFamily ?? null),
            })
          }
        />
      </div>
    </>
  );
}
