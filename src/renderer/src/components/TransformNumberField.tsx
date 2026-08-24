import React from "react";
import { NumberField } from "./ui/NumberField";

type TransformNumberFieldProps = {
  label: string;
  ariaLabel?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  invalid?: boolean;
  /**
   * Set when the row already carries a slider. The slider is the coarse
   * adjustment, so −/+ buttons beside it are redundant clutter.
   */
  hasSlider?: boolean;
  onCommit: (value: number) => void;
};

export function TransformNumberField({
  label,
  ariaLabel,
  value,
  min,
  max,
  step = 1,
  unit,
  disabled = false,
  invalid = false,
  hasSlider = false,
  onCommit,
}: TransformNumberFieldProps): React.JSX.Element {
  return (
    <label className="transform-number-field">
      {label ? <span>{label}</span> : null}
      <NumberField
        variant={hasSlider ? "framed" : "scrubber"}
        inputMode="decimal"
        ariaLabel={ariaLabel ?? label}
        invalid={invalid}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        precision={resolveStepPrecision(step)}
        unit={unit}
        value={value}
        commitMode="blur"
        onValueChange={onCommit}
      />
    </label>
  );
}

function resolveStepPrecision(step: number): number {
  return String(step).split(".")[1]?.length ?? 0;
}
