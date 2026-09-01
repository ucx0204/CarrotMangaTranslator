import { useTranslation } from "react-i18next";
import type {
  TextEffect,
  TextGlow,
  TranslationBlock,
} from "../../../shared/textTypes";
import {
  MAX_TEXT_EFFECT_BLUR_PX,
  MAX_TEXT_EFFECT_OFFSET_PX,
  MIN_TEXT_EFFECT_BLUR_PX,
  MIN_TEXT_EFFECT_OFFSET_PX,
  TEXT_EFFECT_LENGTH_STEP_PX,
  resolveTextEffect,
} from "../../../shared/textEffect";
import {
  MAX_TEXT_GLOW_BLUR_PX,
  MIN_TEXT_GLOW_BLUR_PX,
  TEXT_GLOW_BLUR_STEP_PX,
  resolveTextGlow,
} from "../../../shared/textGlow";
import { ColorField } from "./ColorField";
import { CheckboxField } from "./ui/CheckboxField";
import { NumberField } from "./ui/NumberField";

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
      <TextGlowControls
        disabled={disabled}
        glow={block.textGlow}
        onChange={(textGlow) => onUpdate({ textGlow })}
      />
    </div>
  );
}

function TextGlowControls({
  disabled,
  glow,
  onChange,
}: {
  disabled: boolean;
  glow: TextGlow | undefined;
  onChange: (glow: TextGlow) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const value = resolveTextGlow(glow);
  const update = (patch: Partial<TextGlow>): void =>
    onChange({ ...value, ...patch });
  const label = t("format.textGlow.title", { defaultValue: "광선" });
  return (
    <div className="text-effect-controls text-glow-controls">
      <div className="text-effect-control-head">
        <CheckboxField
          className="editor-appearance-toggle text-effect-enabled-toggle"
          label={label}
          checked={value.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
        {value.enabled ? (
          <ColorField
            className="editor-appearance-color"
            label={t("format.textGlow.color", { defaultValue: "광선색" })}
            labelHidden
            value={value.color}
            disabled={disabled}
            onChange={(color) => update({ color })}
          />
        ) : null}
      </div>
      {value.enabled ? (
        <div className="text-effect-number-grid text-glow-number-grid">
          <TextEffectNumberField
            disabled={disabled}
            label={t("format.textGlow.blur", { defaultValue: "번짐" })}
            min={MIN_TEXT_GLOW_BLUR_PX}
            max={MAX_TEXT_GLOW_BLUR_PX}
            step={TEXT_GLOW_BLUR_STEP_PX}
            value={value.blurPx}
            onChange={(blurPx) => update({ blurPx })}
          />
          <TextEffectNumberField
            disabled={disabled}
            label={t("format.textGlow.opacity", { defaultValue: "불투명도" })}
            min={0}
            max={100}
            precision={0}
            step={1}
            unit="%"
            value={Math.round(value.opacity * 100)}
            onChange={(opacity) => update({ opacity: opacity / 100 })}
          />
        </div>
      ) : null}
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
      <div className="text-effect-control-head">
        <CheckboxField
          className="editor-appearance-toggle text-effect-enabled-toggle"
          label={t("format.textEffect.enabled")}
          checked={value.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
        {value.enabled ? (
          <ColorField
            className="editor-appearance-color"
            label={t("format.textEffect.color")}
            labelHidden
            value={value.color}
            disabled={disabled}
            onChange={(color) => update({ color })}
          />
        ) : null}
      </div>
      {value.enabled ? (
        <div className="text-effect-number-grid">
          <TextEffectNumberField
            disabled={disabled}
            label={t("format.textEffect.offsetX")}
            min={MIN_TEXT_EFFECT_OFFSET_PX}
            max={MAX_TEXT_EFFECT_OFFSET_PX}
            value={value.offsetXpx}
            onChange={(offsetXpx) => update({ offsetXpx })}
          />
          <TextEffectNumberField
            disabled={disabled}
            label={t("format.textEffect.offsetY")}
            min={MIN_TEXT_EFFECT_OFFSET_PX}
            max={MAX_TEXT_EFFECT_OFFSET_PX}
            value={value.offsetYpx}
            onChange={(offsetYpx) => update({ offsetYpx })}
          />
          <TextEffectNumberField
            disabled={disabled}
            label={t("format.textEffect.blur")}
            min={MIN_TEXT_EFFECT_BLUR_PX}
            max={MAX_TEXT_EFFECT_BLUR_PX}
            value={value.blurPx}
            onChange={(blurPx) => update({ blurPx })}
          />
          <TextEffectNumberField
            disabled={disabled}
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
      ) : null}
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
      <NumberField
        variant="scrubber"
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
