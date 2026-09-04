import React from "react";
import {
  formatNumber,
  normalizeNumberFieldValue,
  parseNumber,
  roundToPrecision,
} from "./numberFieldValue";

export type NumberDraftOptions = {
  allowEmpty: boolean;
  commitMode: "change" | "blur";
  emit: (value: number | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  max: number;
  min: number;
  mixed: boolean;
  precision: number;
  snapToStep: boolean;
  step: number;
  value: number | null;
};

export type NumberDraftHandlers = {
  onBlur: React.FocusEventHandler<HTMLInputElement>;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
};

/**
 * Keeps the in-progress text separate from the committed number so typing is
 * never fought by normalization. Commits on blur or Enter (or on every keystroke
 * in `change` mode), restores on Escape, and only emits values inside the range.
 */
export function useNumberFieldDraft(
  options: NumberDraftOptions,
): NumberDraftHandlers & { value: string } {
  const { inputRef, mixed, precision, value } = options;
  const format = React.useCallback(
    (next: number | null): string =>
      next === null ? "" : formatNumber(next, precision),
    [precision],
  );
  const [draft, setDraft] = React.useState(() => (mixed ? "" : format(value)));
  React.useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(mixed ? "" : format(value));
    }
  }, [format, inputRef, mixed, value]);

  const restore = (): void => setDraft(mixed ? "" : format(value));
  const commit = (): void => {
    const parsed = parseNumber(draft);
    if (parsed === null) {
      if (!options.allowEmpty || draft.trim()) return restore();
      setDraft("");
      if (value !== null) options.emit(null);
      return;
    }
    const next = normalize(options, parsed);
    setDraft(format(next));
    if (!isSameValue(options, next)) options.emit(next);
  };

  return {
    value: draft,
    ...createNumberDraftHandlers({
      commit,
      draft,
      format,
      options,
      restore,
      setDraft,
    }),
  };
}

function createNumberDraftHandlers({
  commit,
  draft,
  format,
  options,
  restore,
  setDraft,
}: {
  commit: () => void;
  draft: string;
  format: (value: number | null) => string;
  options: NumberDraftOptions;
  restore: () => void;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
}): NumberDraftHandlers {
  const { commitMode, max, min } = options;
  const onChange: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const nextDraft = event.target.value;
    setDraft(nextDraft);
    if (commitMode !== "change") return;
    const parsed = parseNumber(nextDraft);
    if (parsed === null) {
      if (options.allowEmpty && !nextDraft.trim() && options.value !== null) {
        options.emit(null);
      }
      return;
    }
    if (parsed < min || parsed > max) return;
    const next = normalize(options, parsed);
    if (!isSameValue(options, next)) options.emit(next);
  };
  const onBlur: React.FocusEventHandler<HTMLInputElement> = (event) => {
    if (event.currentTarget.dataset.skipNumberBlur === "true") {
      delete event.currentTarget.dataset.skipNumberBlur;
      return;
    }
    if (commitMode === "blur") return commit();
    const parsed = parseNumber(draft);
    if (parsed === null) {
      if (!options.allowEmpty || draft.trim()) restore();
      return;
    }
    if (parsed < min || parsed > max) restore();
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

function normalize(options: NumberDraftOptions, value: number): number {
  return normalizeNumberFieldValue(
    value,
    options.min,
    options.max,
    options.precision,
    options.step,
    options.snapToStep,
  );
}

function isSameValue(options: NumberDraftOptions, next: number): boolean {
  return (
    !options.mixed &&
    options.value !== null &&
    next === roundToPrecision(options.value, options.precision)
  );
}
