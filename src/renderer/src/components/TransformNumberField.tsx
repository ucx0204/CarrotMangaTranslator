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
  onCommit,
}: TransformNumberFieldProps): React.JSX.Element {
  return (
    <label className="transform-number-field">
      {label ? <span>{label}</span> : null}
      <span className="transform-number-input-wrap">
        <NumberField
          inputMode="decimal"
          ariaLabel={ariaLabel ?? label}
          invalid={invalid}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          precision={resolveStepPrecision(step)}
          value={value}
          commitMode="blur"
          onValueChange={onCommit}
        />
        {unit ? <small aria-hidden="true">{unit}</small> : null}
      </span>
    </label>
  );
}

function resolveStepPrecision(step: number): number {
  return String(step).split(".")[1]?.length ?? 0;
}
