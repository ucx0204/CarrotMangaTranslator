import React from "react";
import { Modal } from "./ui";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  commands: Command[];
  onClose: () => void;
};

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActiveIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return commands;
    }
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase().includes(q)
    );
  }, [commands, query]);

  React.useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  React.useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(".command-palette-item.active");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered.length]);

  if (!open) {
    return null;
  }

  const runIndex = (index: number): void => {
    const command = filtered[index];
    if (!command) {
      return;
    }
    onClose();
    command.run();
  };

  const onInputKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runIndex(activeIndex);
    }
  };

  return (
    <Modal ariaLabel="명령 팔레트" title="명령 팔레트" size="md" onClose={onClose} bodyClassName="command-palette-body">
      <input
        ref={inputRef}
        className="command-palette-input"
        placeholder="명령 검색…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onInputKeyDown}
        aria-label="명령 검색"
      />
      <div className="command-palette-list" ref={listRef} role="listbox" aria-label="명령 목록">
        {filtered.length === 0 ? (
          <p className="command-palette-empty">일치하는 명령이 없습니다.</p>
        ) : (
          filtered.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`command-palette-item ${index === activeIndex ? "active" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runIndex(index)}
            >
              <span className="command-palette-label">{command.label}</span>
              {command.hint ? <span className="command-palette-hint">{command.hint}</span> : null}
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
