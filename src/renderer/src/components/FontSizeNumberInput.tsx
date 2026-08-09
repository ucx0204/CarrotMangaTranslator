import React from "react";
import { NumberField } from "./ui/NumberField";

export function FontSizeNumberInput({
  ariaLabel,
  className = "",
  disabled = false,
  max = 160,
  min = 10,
  mixed = false,
  value,
  onValueChange,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  max?: number;
  min?: number;
  mixed?: boolean;
  value: number;
  onValueChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <NumberField
      className={["font-size-number-input", className]
        .filter(Boolean)
        .join(" ")}
      inputMode="numeric"
      ariaLabel={ariaLabel}
      min={min}
      max={max}
      step={1}
      precision={0}
      value={value}
      mixed={mixed}
      disabled={disabled}
      commitMode="change"
      onValueChange={onValueChange}
    />
  );
}
