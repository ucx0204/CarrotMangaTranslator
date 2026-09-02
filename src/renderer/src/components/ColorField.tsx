import React from "react";

type ColorFieldProps = {
  className?: string;
  label: string;
  labelHidden?: boolean;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

export function ColorField({
  className,
  label,
  labelHidden = false,
  value,
  disabled,
  onChange,
}: ColorFieldProps): React.JSX.Element {
  const normalizedValue = normalizeHexColor(value) ?? "#000000";
  const canonicalDraft = normalizedValue.toUpperCase();
  const [draft, setDraft] = React.useState<string | null>(null);
  const displayedDraft = draft ?? canonicalDraft;

  const publishValidDraft = (nextDraft: string): boolean => {
    const next = normalizeHexColor(nextDraft);
    if (!next) return false;
    if (next !== normalizedValue) onChange(next);
    return true;
  };

  const changeDraft = (nextDraft: string): void => {
    const upperDraft = nextDraft.toUpperCase();
    setDraft(upperDraft);
    publishValidDraft(upperDraft);
  };

  return (
    <div className={["color-field", className].filter(Boolean).join(" ")}>
      <span className={labelHidden ? "visually-hidden" : "color-field-label"}>
        {label}
      </span>
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
            onChange={(event) => publishValidDraft(event.target.value)}
            aria-label={label}
          />
        </span>
        <input
          className="color-hex-input"
          data-ui-framed-input=""
          type="text"
          inputMode="text"
          maxLength={7}
          spellCheck={false}
          value={displayedDraft}
          disabled={disabled}
          aria-label={`${label} HEX`}
          onChange={(event) => changeDraft(event.target.value)}
          onBlur={() => {
            publishValidDraft(displayedDraft);
            if (draft !== null) setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
        />
      </span>
    </div>
  );
}

function normalizeHexColor(value: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match?.[1] ? `#${match[1].toLowerCase()}` : null;
}
