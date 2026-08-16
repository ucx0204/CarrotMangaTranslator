import React from "react";
import { IconSwitchHorizontal } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { TextEffect } from "../../../shared/textTypes";
import {
  MAX_TEXT_EFFECT_BLUR_PX,
  MAX_TEXT_EFFECT_OFFSET_PX,
  MIN_TEXT_EFFECT_BLUR_PX,
  MIN_TEXT_EFFECT_OFFSET_PX,
  TEXT_EFFECT_LENGTH_STEP_PX,
  resolveTextEffect,
} from "../../../shared/textEffect";
import {
  DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX,
  MAX_TEXT_OUTLINE_WIDTH_PX,
  MIN_TEXT_OUTLINE_WIDTH_PX,
  TEXT_OUTLINE_WIDTH_STEP_PX,
  resolveEffectiveTextOutlineWidthPx,
  snapTextOutlineWidthPx,
} from "../../../shared/textOutline";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import { BlockBackgroundApplyModal } from "./BlockBackgroundApplyModal";
import { ColorField } from "./ColorField";
import { resolveColor, type EditorPanelModel } from "./editorPanelUtils";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { FieldSlider } from "./ui/FieldSlider";
import { IconButton } from "./ui/IconButton";
import { ScrubbableNumberField } from "./ui/ScrubbableNumberField";

let lastPositiveOutlineWidthPx = DEFAULT_MANUAL_TEXT_OUTLINE_WIDTH_PX;

type EditorColorGroupProps = {
  block: TranslationBlock;
  disabled: boolean;
  model: EditorPanelModel;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
};

export function EditorColorGroup({
  block,
  disabled,
  model,
  onUpdate,
}: EditorColorGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const outline = useEditorOutlineControls(block, onUpdate);
  return (
    <div className="editor-group">
      <div className="editor-group-head">
        <h3>{t("format.color")}</h3>
        <IconButton
          size="sm"
          label={t("editor.swapTextOutlineColors")}
          title={t("editor.swapTextOutlineColors")}
          disabled={disabled}
          onClick={() =>
            onUpdate({
              textColor: model.outlineColor,
              outlineColor: resolveColor(block.textColor, "#111111"),
            })
          }
        >
          <IconSwitchHorizontal size={15} stroke={2.1} aria-hidden="true" />
        </IconButton>
      </div>
      <CheckboxField
        className="inline-toggle editor-outline-enabled-toggle"
        label={t("settings.format.color.outlineEnabled")}
        checked={outline.enabled}
        disabled={disabled}
        onCheckedChange={outline.toggle}
      />
      <div className="color-row" aria-label={t("editor.blockColors")}>
        <ColorField
          label={t("format.textColor")}
          value={resolveColor(block.textColor, "#111111")}
          disabled={disabled}
          onChange={(textColor) => onUpdate({ textColor })}
        />
        <ColorField
          label={t("format.outline")}
          value={model.outlineColor}
          disabled={disabled || !outline.enabled}
          onChange={(outlineColor) => onUpdate({ outlineColor })}
        />
      </div>
      <div className="editor-outline-width-control">
        <span>{t("gatherText.outlineWidth")}</span>
        <ScrubbableNumberField
          ariaLabel={t("gatherText.outlineWidth")}
          decreaseLabel={t("format.decreaseValue", {
            label: t("gatherText.outlineWidth"),
          })}
          increaseLabel={t("format.increaseValue", {
            label: t("gatherText.outlineWidth"),
          })}
          max={MAX_TEXT_OUTLINE_WIDTH_PX}
          min={MIN_TEXT_OUTLINE_WIDTH_PX}
          precision={1}
          step={TEXT_OUTLINE_WIDTH_STEP_PX}
          unit="px"
          value={outline.widthPx}
          disabled={disabled || !outline.enabled}
          onValueChange={outline.updateWidth}
        />
      </div>
    </div>
  );
}

export function EditorTextEffectGroup({
  block,
  disabled,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-group editor-text-effect-group">
      <div className="editor-group-head">
        <h3>{t("format.textEffect.title")}</h3>
      </div>
      <TextEffectControls
        disabled={disabled}
        effect={block.textEffect}
        onChange={(textEffect) => onUpdate({ textEffect })}
      />
    </div>
  );
}

export function TextEffectControls({
  disabled,
  effect,
  onChange,
}: {
  disabled: boolean;
  effect: TextEffect | undefined;
  onChange: (effect: TextEffect) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const value = resolveTextEffect(effect);
  const update = (patch: Partial<TextEffect>): void =>
    onChange({ ...value, ...patch });
  return (
    <div className="text-effect-controls">
      <CheckboxField
        className="inline-toggle text-effect-enabled-toggle"
        label={t("format.textEffect.enabled")}
        checked={value.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) => update({ enabled })}
      />
      <ColorField
        label={t("format.textEffect.color")}
        value={value.color}
        disabled={disabled || !value.enabled}
        onChange={(color) => update({ color })}
      />
      <div className="text-effect-number-grid">
        <TextEffectNumberField
          disabled={disabled || !value.enabled}
          label={t("format.textEffect.offsetX")}
          min={MIN_TEXT_EFFECT_OFFSET_PX}
          max={MAX_TEXT_EFFECT_OFFSET_PX}
          value={value.offsetXpx}
          onChange={(offsetXpx) => update({ offsetXpx })}
        />
        <TextEffectNumberField
          disabled={disabled || !value.enabled}
          label={t("format.textEffect.offsetY")}
          min={MIN_TEXT_EFFECT_OFFSET_PX}
          max={MAX_TEXT_EFFECT_OFFSET_PX}
          value={value.offsetYpx}
          onChange={(offsetYpx) => update({ offsetYpx })}
        />
        <TextEffectNumberField
          disabled={disabled || !value.enabled}
          label={t("format.textEffect.blur")}
          min={MIN_TEXT_EFFECT_BLUR_PX}
          max={MAX_TEXT_EFFECT_BLUR_PX}
          value={value.blurPx}
          onChange={(blurPx) => update({ blurPx })}
        />
        <TextEffectNumberField
          disabled={disabled || !value.enabled}
          label={t("format.textEffect.opacity")}
          min={0}
          max={100}
          precision={0}
          step={1}
          unit="%"
          value={Math.round(value.opacity * 100)}
          onChange={(opacity) => update({ opacity: opacity / 100 })}
        />
      </div>
    </div>
  );
}

function TextEffectNumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  precision = 1,
  step = TEXT_EFFECT_LENGTH_STEP_PX,
  unit = "px",
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  precision?: number;
  step?: number;
  unit?: string;
  value: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="editor-format-number-cell">
      <span>{label}</span>
      <ScrubbableNumberField
        ariaLabel={label}
        decreaseLabel={t("format.decreaseValue", { label })}
        increaseLabel={t("format.increaseValue", { label })}
        disabled={disabled}
        max={max}
        min={min}
        precision={precision}
        step={step}
        unit={unit}
        value={value}
        onValueChange={onChange}
      />
    </div>
  );
}

function useEditorOutlineControls(
  block: TranslationBlock,
  onUpdate: (patch: Partial<TranslationBlock>) => void,
): {
  enabled: boolean;
  widthPx: number;
  toggle: (checked: boolean) => void;
  updateWidth: (value: number) => void;
} {
  const widthPx = resolveEffectiveTextOutlineWidthPx(block, block.fontSizePx);
  React.useEffect(() => {
    if (widthPx > 0) {
      lastPositiveOutlineWidthPx = snapTextOutlineWidthPx(widthPx);
    }
  }, [widthPx]);
  return {
    enabled: widthPx > 0,
    widthPx,
    toggle: (checked) => {
      if (!checked) {
        if (widthPx > 0) {
          lastPositiveOutlineWidthPx = snapTextOutlineWidthPx(widthPx);
        }
        onUpdate({ outlineWidthPx: 0 });
        return;
      }
      onUpdate({ outlineWidthPx: lastPositiveOutlineWidthPx });
    },
    updateWidth: (value) => {
      const normalized = snapTextOutlineWidthPx(value);
      if (normalized > 0) lastPositiveOutlineWidthPx = normalized;
      onUpdate({ outlineWidthPx: normalized });
    },
  };
}

export function BlockDisplayGroup({
  block,
  disabled,
  disableChapterApply,
  onApply,
  onUpdate,
}: {
  block: TranslationBlock;
  disabled: boolean;
  disableChapterApply: boolean;
  onApply?: (scope: BlockBackgroundApplyScope) => void;
  onUpdate: (patch: Partial<TranslationBlock>) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [batchOpen, setBatchOpen] = React.useState(false);
  return (
    <div className="editor-group editor-display-group">
      <div className="editor-group-head">
        <h3>{t("editor.display.title")}</h3>
        {onApply ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setBatchOpen(true)}
          >
            {t("editor.display.batchApply")}
          </Button>
        ) : null}
      </div>
      <FieldSlider
        label={t("format.blockBackgroundOpacity")}
        valueLabel={`${Math.round(block.opacity * 100)}%`}
        min={0}
        max={1}
        step={0.01}
        value={block.opacity}
        disabled={disabled}
        onChange={(event) => onUpdate({ opacity: Number(event.target.value) })}
      />
      {batchOpen && onApply ? (
        <BlockBackgroundApplyModal
          disableChapterApply={disableChapterApply}
          onApply={onApply}
          onClose={() => setBatchOpen(false)}
        />
      ) : null}
    </div>
  );
}
