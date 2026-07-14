import React from "react";

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
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [draft, setDraft] = React.useState(() =>
    mixed ? "" : String(Math.round(value)),
  );

  React.useEffect(() => {
    if (!focused) {
      setDraft(mixed ? "" : String(Math.round(value)));
    }
  }, [focused, mixed, value]);

  const applyIfValid = (raw: string): boolean => {
    const parsed = Number(raw);
    if (
      !raw.trim() ||
      !Number.isFinite(parsed) ||
      parsed < min ||
      parsed > max
    ) {
      return false;
    }
    onValueChange(Math.round(parsed));
    return true;
  };

  return (
    <input
      ref={inputRef}
      className={["font-size-number-input", className]
        .filter(Boolean)
        .join(" ")}
      type="number"
      inputMode="numeric"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={1}
      value={draft}
      placeholder={mixed ? "—" : undefined}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        applyIfValid(next);
      }}
      onBlur={() => {
        setFocused(false);
        if (!applyIfValid(draft)) {
          setDraft(mixed ? "" : String(Math.round(value)));
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          inputRef.current?.blur();
        }
      }}
    />
  );
}
