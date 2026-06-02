import React from "react";
import { useFonts } from "../fonts/FontsContext";
import { normalizeBlockFontFamily, resolveBlockFontFamily, resolveBlockFontOption } from "../lib/fonts";

type FontSelectProps = {
  value: string | undefined;
  disabled?: boolean;
  onChange: (fontFamily: string | undefined) => void;
};

export function FontSelect({ value, disabled = false, onChange }: FontSelectProps): React.JSX.Element {
  const { options, customFonts, registerFont, removeFont, busy } = useFonts();
  const customIds = React.useMemo(() => new Set(customFonts.map((font) => font.id)), [customFonts]);
  const selected = resolveBlockFontOption(value);
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(() => Math.max(0, options.findIndex((option) => option.id === selected.id)));
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
      setActiveIndex(Math.max(0, options.findIndex((option) => option.id === selected.id)));
    }
  }, [open, selected.id, options]);

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
      setActiveIndex((index) => Math.min(options.length - 1, index + 1));
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
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) {
        commit(option.id);
      }
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
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="font-select-name">{selected.label}</span>
        <span className="font-select-sample" style={{ fontFamily: resolveBlockFontFamily(selected.id) }}>
          {selected.sample}
        </span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="font-select-menu">
          <div className="font-select-options" role="listbox" tabIndex={-1} ref={listRef} onKeyDown={onListKeyDown}>
            {options.map((option, index) => (
              <div
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
                {customIds.has(option.id) ? (
                  <button
                    type="button"
                    className="font-select-remove"
                    title="이 폰트 삭제"
                    aria-label={`${option.label} 삭제`}
                    disabled={busy}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void removeFont(option.id);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="font-select-add"
            disabled={busy}
            onClick={() => {
              close();
              void registerFont();
            }}
          >
            + TTF/OTF 폰트 등록
          </button>
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
