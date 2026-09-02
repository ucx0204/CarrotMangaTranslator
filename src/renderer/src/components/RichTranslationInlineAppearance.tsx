import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_TEXT_GLOW_BLUR_PX,
  MIN_TEXT_GLOW_BLUR_PX,
} from "../../../shared/textGlow";
import {
  MAX_TEXT_OUTLINE_WIDTH_PX,
  MIN_TEXT_OUTLINE_WIDTH_PX,
  TEXT_OUTLINE_WIDTH_STEP_PX,
} from "../../../shared/textOutline";
import { ColorField } from "./ColorField";
import { RichTranslationInlineNumberField } from "./RichTranslationInlineNumberField";
import type {
  RichTranslationInlineStyleAction,
  RichTranslationSelectionValues,
} from "./richTranslationEditorTypes";
import { CheckboxField } from "./ui/CheckboxField";

type RichTranslationInlineAppearanceProps = {
  disabled: boolean;
  values: RichTranslationSelectionValues;
  onApplyStyle: RichTranslationInlineStyleAction;
};

export function RichTranslationInlineAppearance(
  props: RichTranslationInlineAppearanceProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="editor-appearance-list rich-inline-appearance-list">
        <div className="editor-appearance-row">
          <span className="editor-appearance-label">
            {t("format.textColor")}
          </span>
          <ColorField
            className="editor-appearance-color"
            label={t("format.textColor")}
            labelHidden
            value={props.values.color}
            disabled={props.disabled}
            onChange={(color) => props.onApplyStyle({ color })}
          />
        </div>
        <InlineBackgroundControl {...props} />
      </div>
      <InlineEffects {...props} />
    </>
  );
}

function InlineBackgroundControl({
  disabled,
  onApplyStyle,
  values,
}: RichTranslationInlineAppearanceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-appearance-row">
      <CheckboxField
        className="editor-appearance-toggle"
        label={t("editor.richText.background", { defaultValue: "글자 배경" })}
        checked={values.backgroundEnabled}
        disabled={disabled}
        onCheckedChange={(enabled) =>
          onApplyStyle({
            backgroundColor: enabled ? values.backgroundColor : null,
          })
        }
      />
      {values.backgroundEnabled ? (
        <ColorField
          className="editor-appearance-color"
          label={t("format.textBackground.color")}
          labelHidden
          value={values.backgroundColor}
          disabled={disabled}
          onChange={(backgroundColor) => onApplyStyle({ backgroundColor })}
        />
      ) : null}
    </div>
  );
}

function InlineEffects(
  props: RichTranslationInlineAppearanceProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <details className="rich-inline-effects">
      <summary>
        {t("editor.richText.effects", { defaultValue: "외곽선 · 광선" })}
      </summary>
      <InlineOutlineControls
        disabled={props.disabled}
        enabled={props.values.outlineEnabled}
        label={t("format.outline")}
        color={props.values.outlineColor}
        widthPx={props.values.outlineWidthPx}
        onEnabledChange={(enabled) =>
          props.onApplyStyle({
            outlineWidthPx: enabled
              ? Math.max(props.values.outlineWidthPx, 1)
              : 0,
          })
        }
        onColorChange={(outlineColor) => props.onApplyStyle({ outlineColor })}
        onWidthChange={(outlineWidthPx) =>
          props.onApplyStyle({ outlineWidthPx })
        }
      />
      <OuterOutlineControls {...props} />
      <InlineGlowControls {...props} />
    </details>
  );
}

function OuterOutlineControls(
  props: RichTranslationInlineAppearanceProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <InlineOutlineControls
      disabled={props.disabled}
      enabled={props.values.outerOutlineEnabled}
      label={t("format.outerOutline.enabled")}
      color={props.values.outerOutlineColor}
      widthPx={props.values.outerOutlineWidthPx}
      onEnabledChange={(enabled) =>
        props.onApplyStyle({
          outerOutlineWidthPx: enabled
            ? Math.max(props.values.outerOutlineWidthPx, 1)
            : 0,
        })
      }
      onColorChange={(outerOutlineColor) =>
        props.onApplyStyle({ outerOutlineColor })
      }
      onWidthChange={(outerOutlineWidthPx) =>
        props.onApplyStyle({ outerOutlineWidthPx })
      }
    />
  );
}

function InlineOutlineControls({
  color,
  disabled,
  enabled,
  label,
  onColorChange,
  onEnabledChange,
  onWidthChange,
  widthPx,
}: {
  color: string;
  disabled: boolean;
  enabled: boolean;
  label: string;
  onColorChange: (value: string) => void;
  onEnabledChange: (value: boolean) => void;
  onWidthChange: (value: number) => void;
  widthPx: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-appearance-row editor-outline-property-row rich-inline-effect-row">
      <CheckboxField
        className="editor-appearance-toggle"
        label={label}
        checked={enabled}
        disabled={disabled}
        onCheckedChange={onEnabledChange}
      />
      {enabled ? (
        <>
          <ColorField
            className="editor-appearance-color"
            label={label}
            labelHidden
            value={color}
            disabled={disabled}
            onChange={onColorChange}
          />
          <div className="rich-inline-outline-width">
            <RichTranslationInlineNumberField
              label={t("gatherText.outlineWidth")}
              labelHidden
              value={widthPx}
              min={MIN_TEXT_OUTLINE_WIDTH_PX}
              max={MAX_TEXT_OUTLINE_WIDTH_PX}
              step={TEXT_OUTLINE_WIDTH_STEP_PX}
              precision={1}
              unit="px"
              disabled={disabled}
              onChange={onWidthChange}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function InlineGlowControls({
  disabled,
  onApplyStyle,
  values,
}: RichTranslationInlineAppearanceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="rich-inline-effect-row rich-inline-glow-row">
      <CheckboxField
        className="editor-appearance-toggle"
        label={t("format.textGlow.title")}
        checked={values.glowEnabled}
        disabled={disabled}
        onCheckedChange={(enabled) =>
          onApplyStyle({ glowOpacity: enabled ? 0.75 : 0 })
        }
      />
      {values.glowEnabled ? (
        <InlineGlowFields
          disabled={disabled}
          values={values}
          onApplyStyle={onApplyStyle}
        />
      ) : null}
    </div>
  );
}

function InlineGlowFields({
  disabled,
  onApplyStyle,
  values,
}: RichTranslationInlineAppearanceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <ColorField
        className="editor-appearance-color"
        label={t("format.textGlow.color")}
        labelHidden
        value={values.glowColor}
        disabled={disabled}
        onChange={(glowColor) => onApplyStyle({ glowColor })}
      />
      <RichTranslationInlineNumberField
        label={t("format.textGlow.blur")}
        value={values.glowBlurPx}
        min={MIN_TEXT_GLOW_BLUR_PX}
        max={MAX_TEXT_GLOW_BLUR_PX}
        step={1}
        precision={1}
        unit="px"
        disabled={disabled}
        onChange={(glowBlurPx) => onApplyStyle({ glowBlurPx })}
      />
      <RichTranslationInlineNumberField
        label={t("format.textGlow.opacity")}
        value={values.glowOpacityPercent}
        min={0}
        max={100}
        step={1}
        precision={0}
        unit="%"
        disabled={disabled}
        onChange={(opacity) => onApplyStyle({ glowOpacity: opacity / 100 })}
      />
    </>
  );
}
