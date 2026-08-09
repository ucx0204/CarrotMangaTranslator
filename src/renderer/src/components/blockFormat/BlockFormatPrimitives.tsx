import React from "react";
import { useTranslation } from "react-i18next";
import { RangeInput } from "../ui/Field";

export function BlockFormatSectionHeading({
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

export function BlockFormatControlCaption({
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
