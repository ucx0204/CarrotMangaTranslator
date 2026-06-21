import React from "react";

type ColorFieldProps = {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

export function ColorField({
  label,
  value,
  disabled,
  onChange,
}: ColorFieldProps): React.JSX.Element {
  return (
    <label className="color-field">
      <span className="color-field-label">{label}</span>
      <span className="color-picker-button">
        <span
          className="color-swatch"
          style={{ backgroundColor: value }}
          aria-hidden="true"
        />
        <code>{value.toUpperCase()}</code>
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
        />
      </span>
    </label>
  );
}
