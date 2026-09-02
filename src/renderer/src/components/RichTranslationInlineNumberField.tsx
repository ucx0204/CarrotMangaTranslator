import React from "react";
import { NumberField } from "./ui/NumberField";

type RichTranslationInlineNumberFieldProps = {
  disabled: boolean;
  label: string;
  labelHidden?: boolean;
  max: number;
  min: number;
  mixed?: boolean;
  onChange: (value: number) => void;
  precision: number;
  step: number;
  unit: string;
  value: number;
};

export function RichTranslationInlineNumberField({
  disabled,
  label,
  labelHidden = false,
  max,
  min,
  mixed = false,
  onChange,
  precision,
  step,
  unit,
  value,
}: RichTranslationInlineNumberFieldProps): React.JSX.Element {
  return (
    <label className="rich-inline-number-field">
      <span className={labelHidden ? "visually-hidden" : undefined}>
        {label}
      </span>
      <NumberField
        variant="framed"
        ariaLabel={label}
        value={value}
        min={min}
        max={max}
        step={step}
        precision={precision}
        useTextInput
        selectOnFocus
        unit={unit}
        commitMode="change"
        mixed={mixed}
        placeholder="—"
        disabled={disabled}
        onValueChange={onChange}
      />
    </label>
  );
}
