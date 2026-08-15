import React from "react";

export type NumberFieldProps = {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  onValueChange: (value: number) => void;
  className?: string;
  commitMode?: "change" | "blur";
  disabled?: boolean;
  inputMode?: "decimal" | "numeric";
  invalid?: boolean;
  mixed?: boolean;
  placeholder?: string;
  precision?: number;
  step?: number;
};

/** Shared numeric draft, clamping, and Enter/Escape behavior. */
export function NumberField({
  ariaLabel,
  value,
  min,
  max,
  onValueChange,
  className,
  commitMode = "blur",
  disabled = false,
  inputMode = "decimal",
  invalid = false,
  mixed = false,
  placeholder,
  precision = 0,
  step = 1,
}: NumberFieldProps): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const {
    value: draftValue,
    onBlur,
    onChange,
    onKeyDown,
  } = useNumberFieldDraft({
    inputRef,
    value,
    min,
    max,
    onValueChange,
    commitMode,
    mixed,
    precision,
  });

  return (
    <input
      ref={inputRef}
      className={className}
      type="number"
      inputMode={inputMode}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      min={min}
      max={max}
      step={step}
      value={draftValue}
      placeholder={mixed ? (placeholder ?? "—") : placeholder}
      disabled={disabled}
      onChange={onChange}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  );
}

type NumberDraftOptions = Required<
  Pick<
    NumberFieldProps,
    | "value"
    | "min"
    | "max"
    | "onValueChange"
    | "commitMode"
    | "mixed"
    | "precision"
  >
> & { inputRef: React.RefObject<HTMLInputElement | null> };

type NumberDraftHandlers = {
  onBlur: React.FocusEventHandler<HTMLInputElement>;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
};

function useNumberFieldDraft({
  inputRef,
  value,
  min,
  max,
  onValueChange,
  commitMode,
  mixed,
  precision,
}: NumberDraftOptions): NumberDraftHandlers & { value: string } {
  const format = React.useCallback(
    (next: number): string => formatNumber(next, precision),
    [precision],
  );
  const [draft, setDraft] = React.useState(() =>
    mixed ? "" : formatNumber(value, precision),
  );
  React.useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(mixed ? "" : format(value));
    }
  }, [format, inputRef, mixed, value]);
  const restore = (): void => setDraft(mixed ? "" : format(value));
  const commit = (): void => {
    const parsed = parseNumber(draft);
    if (parsed === null) return restore();
    const next = roundToPrecision(
      Math.min(max, Math.max(min, parsed)),
      precision,
    );
    setDraft(format(next));
    if (next !== roundToPrecision(value, precision)) onValueChange(next);
  };
  const handlers = createNumberDraftHandlers({
    commit,
    commitMode,
    draft,
    format,
    max,
    min,
    onValueChange,
    precision,
    restore,
    setDraft,
    value,
  });
  return { value: draft, ...handlers };
}

function createNumberDraftHandlers({
  commit,
  commitMode,
  draft,
  format,
  max,
  min,
  onValueChange,
  precision,
  restore,
  setDraft,
  value,
}: Omit<NumberDraftOptions, "inputRef" | "mixed"> & {
  commit: () => void;
  draft: string;
  format: (value: number) => string;
  restore: () => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
}): NumberDraftHandlers {
  const onChange: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const nextDraft = event.target.value;
    setDraft(nextDraft);
    const parsed = parseNumber(nextDraft);
    if (
      commitMode !== "change" ||
      parsed === null ||
      parsed < min ||
      parsed > max
    ) {
      return;
    }
    const next = roundToPrecision(parsed, precision);
    if (next !== roundToPrecision(value, precision)) onValueChange(next);
  };
  const onBlur: React.FocusEventHandler<HTMLInputElement> = (event) => {
    if (event.currentTarget.dataset.skipNumberBlur === "true") {
      delete event.currentTarget.dataset.skipNumberBlur;
      return;
    }
    if (commitMode === "blur") return commit();
    const parsed = parseNumber(draft);
    if (parsed === null || parsed < min || parsed > max) restore();
    else setDraft(format(parsed));
  };
  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "Enter") {
      if (commitMode === "blur") {
        event.currentTarget.dataset.skipNumberBlur = "true";
        commit();
      }
      event.currentTarget.blur();
      delete event.currentTarget.dataset.skipNumberBlur;
    } else if (event.key === "Escape") {
      event.currentTarget.dataset.skipNumberBlur = "true";
      restore();
      event.currentTarget.blur();
      delete event.currentTarget.dataset.skipNumberBlur;
      event.stopPropagation();
    }
  };
  return { onBlur, onChange, onKeyDown };
}

function parseNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToPrecision(value: number, precision: number): number {
  const scale = 10 ** Math.max(0, precision);
  return Math.round(value * scale) / scale;
}

function formatNumber(value: number, precision: number): string {
  return String(roundToPrecision(value, precision));
}
