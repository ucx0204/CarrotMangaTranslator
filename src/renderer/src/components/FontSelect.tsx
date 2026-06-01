import React from "react";
import {
  BLOCK_FONT_OPTIONS,
  normalizeBlockFontFamily,
  resolveBlockFontFamily,
  resolveBlockFontOption
} from "../lib/fonts";

type FontSelectProps = {
  value: string | undefined;
  disabled?: boolean;
  onChange: (fontFamily: string | undefined) => void;
};

export function FontSelect({ value, disabled = false, onChange }: FontSelectProps): React.JSX.Element {
  const selected = resolveBlockFontOption(value);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(() =>
    Math.max(0, BLOCK_FONT_OPTIONS.findIndex((option) => option.id === selected.id))
  );
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  React.useEffect(() => {
    if (open) {
      setActiveIndex(Math.max(0, BLOCK_FONT_OPTIONS.findIndex((option) => option.id === selected.id)));
    }
  }, [open, selected.id]);

  React.useEffect(() => {
    if (!open || !listRef.current) {
      return;
    }
    const node = listRef.current.children[activeIndex] as HTMLElement | undefined;
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const commit = React.useCallback(
    (id: string) => {
      onChange(normalizeBlockFontFamily(id));
      close();
    },
    [onChange, close]
  );

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(BLOCK_FONT_OPTIONS.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(BLOCK_FONT_OPTIONS.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(BLOCK_FONT_OPTIONS[activeIndex].id);
    }
  };

  return (
    <div className={`font-select ${open ? "open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="font-select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="font-select-name">{selected.label}</span>
        <span className="font-select-sample" style={{ fontFamily: resolveBlockFontFamily(selected.id) }}>
          {selected.sample}
        </span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="font-select-menu" role="listbox" tabIndex={-1} ref={listRef} onKeyDown={onListKeyDown}>
          {BLOCK_FONT_OPTIONS.map((option, index) => (
            <button
              type="button"
              key={option.id}
              role="option"
              aria-selected={option.id === selected.id}
              className={[
                "font-select-option",
                option.id === selected.id ? "selected" : "",
                index === activeIndex ? "active" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              onPointerEnter={() => setActiveIndex(index)}
              onClick={() => commit(option.id)}
            >
              <span className="font-select-option-label">{option.label}</span>
              <span className="font-select-option-sample" style={{ fontFamily: resolveBlockFontFamily(option.id) }}>
                {option.sample}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg className="font-select-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
