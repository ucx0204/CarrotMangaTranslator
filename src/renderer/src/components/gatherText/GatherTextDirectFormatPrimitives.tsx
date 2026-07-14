import React from "react";
import { useTranslation } from "react-i18next";
import { RangeInput } from "../ui/Field";
import type {
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
} from "../../lib/gatherTextDirectFormatModel";
import {
  clampDirectFormatValue,
  hasDirectFormatField,
  resolveControlState,
  resolvePreviewValue,
} from "./gatherTextDirectFormatUi";

export type DirectSliderField =
  | "lineHeight"
  | "letterSpacing"
  | "fontWidthScale"
  | "outlineWidthScale"
  | "rotationDeg"
  | "textOpacity";

export function DirectSectionHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.JSX.Element {
  return (
    <div className="gather-direct-editor-section-head">
      <strong>{title}</strong>
      {description ? <small>{description}</small> : null}
    </div>
  );
}

export function DirectControlCaption({
  label,
  mixed,
  touched,
}: {
  label: string;
  mixed: boolean;
  touched: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <span className="gather-direct-control-caption">
      <span>{label}</span>
      {mixed && !touched ? <small>{t("gatherText.mixedValue")}</small> : null}
    </span>
  );
}

export function DirectSliderControl<Field extends DirectSliderField>({
  field,
  label,
  min,
  max,
  step,
  formatValue,
  disabled,
  model,
  patch,
  onChange,
}: {
  field: Field;
  label: string;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  disabled: boolean;
  model: GatherTextDirectFormatModel;
  patch: GatherTextDirectFormatPatch;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = resolveControlState(model.values, patch, field);
  const touched = hasDirectFormatField(patch, field);
  const value = resolvePreviewValue(model, patch, field);
  const clampedValue = clampDirectFormatValue(value, min, max);
  const mixed = state.kind === "mixed" && !touched;
  return (
    <FormatSliderControl
      label={label}
      valueLabel={mixed ? t("gatherText.mixedValue") : formatValue(value)}
      min={min}
      max={max}
      step={step}
      value={clampedValue}
      disabled={disabled}
      mixed={mixed}
      touched={touched}
      onChange={onChange}
    />
  );
}

export function FormatSliderControl({
  disabled = false,
  label,
  max,
  min,
  mixed = false,
  step,
  touched = false,
  value,
  valueLabel,
  onChange,
}: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  mixed?: boolean;
  step: number;
  touched?: boolean;
  value: number;
  valueLabel: string;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label
      className="gather-direct-slider-control"
      data-touched={touched || undefined}
      data-mixed={mixed || undefined}
    >
      <span className="gather-direct-slider-head">
        <span>{label}</span>
        <output>{valueLabel}</output>
      </span>
      <RangeInput
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
