import React from "react";
import { Field } from "../ui/Field";
import { NumberField } from "../ui/NumberField";
import { resolveStepPrecision } from "../ui/numberFieldValue";

export type SettingsNumberFieldProps = {
  /** Plain-text accessible name; also used as the visible label when `label` is omitted. */
  ariaLabel: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  /**
   * The form keeps these as strings because an empty string is a meaningful
   * value ("use the provider default") for optional settings.
   */
  value: string;
  onValueChange: (next: string) => void;
  min: number;
  /** Omit for settings the schema leaves unbounded (e.g. context tokens). */
  max?: number;
  step?: number;
  precision?: number;
  /** Blank is allowed and means "leave it to the provider default". */
  optional?: boolean;
  disabled?: boolean;
  className?: string;
  unit?: string;
  /** Pressing Enter inside the field runs this (settings panels save on Enter). */
  onSubmit?: () => void;
};

/**
 * The one numeric settings row. Bridges the form's string state to the shared
 * `NumberField` so every settings number gets the same clamping, step snapping,
 * and label layout instead of a hand-rolled `<label><input type="number">`.
 */
export function SettingsNumberField({
  ariaLabel,
  label,
  hint,
  value,
  onValueChange,
  min,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  precision,
  optional = false,
  disabled = false,
  className,
  unit,
  onSubmit,
}: SettingsNumberFieldProps): React.JSX.Element {
  const parsed = parseSettingsNumber(value);
  const resolvedPrecision = precision ?? resolveStepPrecision(step);
  const commit = (next: number | null): void => {
    onValueChange(next === null ? "" : String(next));
  };
  const shared = {
    ariaLabel,
    className: "settings-number-input",
    commitMode: "change",
    disabled,
    inputMode: resolvedPrecision > 0 ? "decimal" : "numeric",
    max,
    min,
    precision: resolvedPrecision,
    step,
    unit,
    useTextInput: true,
  } as const;
  return (
    <Field
      label={label ?? ariaLabel}
      hint={hint}
      density="comfortable"
      className={className}
      onKeyDown={
        onSubmit
          ? (event) => {
              if (event.key === "Enter") onSubmit();
            }
          : undefined
      }
    >
      {optional ? (
        <NumberField
          {...shared}
          allowEmpty
          placeholder={""}
          value={parsed}
          onValueChange={commit}
        />
      ) : (
        <NumberField
          {...shared}
          value={parsed ?? min}
          onValueChange={(next) => commit(next)}
        />
      )}
    </Field>
  );
}

function parseSettingsNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
