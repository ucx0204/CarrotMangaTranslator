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
  const normalizedValue = normalizeHexColor(value) ?? "#000000";
  const [draft, setDraft] = React.useState(normalizedValue.toUpperCase());
  React.useEffect(() => {
    setDraft(normalizedValue.toUpperCase());
  }, [normalizedValue]);

  const commitDraft = (nextDraft: string): void => {
    setDraft(nextDraft.toUpperCase());
    const next = normalizeHexColor(nextDraft);
    if (next) onChange(next);
  };

  return (
    <label className="color-field">
      <span className="color-field-label">{label}</span>
      <span className="color-picker-button">
        <span className="color-native-picker">
          <span
            className="color-swatch"
            style={{ backgroundColor: normalizedValue }}
            aria-hidden="true"
          />
          <input
            type="color"
            value={normalizedValue}
            disabled={disabled}
            onChange={(event) => commitDraft(event.target.value)}
            aria-label={label}
          />
        </span>
        <input
          className="color-hex-input"
          type="text"
          inputMode="text"
          maxLength={7}
          spellCheck={false}
          value={draft}
          disabled={disabled}
          aria-label={`${label} HEX`}
          onChange={(event) => commitDraft(event.target.value)}
          onBlur={() => setDraft(normalizedValue.toUpperCase())}
        />
      </span>
    </label>
  );
}

function normalizeHexColor(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match?.[1] ? `#${match[1].toLowerCase()}` : null;
}
