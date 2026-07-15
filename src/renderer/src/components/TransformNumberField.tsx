import React from "react";

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

/**
 * Compact numeric field that commits on blur/Enter and restores its previous
 * value on Escape. Keeping an input draft avoids destructive updates while a
 * user is midway through typing a minus sign or decimal value.
 */
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
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const cancelBlurRef = React.useRef(false);
  const [draft, setDraft] = React.useState(formatNumber(value));

  React.useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(formatNumber(value));
    }
  }, [value]);

  const restore = (): void => setDraft(formatNumber(value));
  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      restore();
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(formatNumber(next));
    if (next !== Number(formatNumber(value))) {
      onCommit(next);
    }
  };

  return (
    <label className="transform-number-field">
      {label ? <span>{label}</span> : null}
      <span className="transform-number-input-wrap">
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          value={draft}
          onBlur={() => {
            if (cancelBlurRef.current) {
              cancelBlurRef.current = false;
              return;
            }
            commit();
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              cancelBlurRef.current = true;
              commit();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              cancelBlurRef.current = true;
              restore();
              event.currentTarget.blur();
              event.stopPropagation();
            }
          }}
        />
        {unit ? <small aria-hidden="true">{unit}</small> : null}
      </span>
    </label>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 10) / 10);
}
