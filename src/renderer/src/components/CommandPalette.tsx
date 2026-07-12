import React from "react";
import { useTranslation } from "react-i18next";
import type { Command } from "../lib/appCommandTypes";
import { Modal } from "./ui";

type CommandPaletteProps = {
  open: boolean;
  commands: Command[];
  onClose: () => void;
};

export function CommandPalette({
  open,
  commands,
  onClose,
}: CommandPaletteProps): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const filtered = React.useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setActiveIndex(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    setActiveIndex((index) =>
      Math.min(index, Math.max(0, filtered.length - 1)),
    );
  }, [filtered.length]);

  React.useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      ".command-palette-item.active",
    );
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
  const onInputKeyDown = (event: React.KeyboardEvent): void =>
    handleCommandPaletteKeyDown({
      activeIndex,
      event,
      filteredCount: filtered.length,
      runIndex,
      setActiveIndex,
    });

  return (
    <Modal
      ariaLabel={t("commandPalette.title")}
      title={t("commandPalette.title")}
      size="md"
      onClose={onClose}
      bodyClassName="command-palette-body"
    >
      <CommandPaletteInput
        ref={inputRef}
        onKeyDown={onInputKeyDown}
        setActiveIndex={setActiveIndex}
        setQuery={setQuery}
        value={query}
      />
      <CommandPaletteList
        activeIndex={activeIndex}
        commands={filtered}
        listRef={listRef}
        runIndex={runIndex}
        setActiveIndex={setActiveIndex}
      />
    </Modal>
  );
}

const CommandPaletteInput = React.forwardRef<
  HTMLInputElement,
  {
    onKeyDown: (event: React.KeyboardEvent) => void;
    setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
    setQuery: React.Dispatch<React.SetStateAction<string>>;
    value: string;
  }
>(function CommandPaletteInput(
  { onKeyDown, setActiveIndex, setQuery, value },
  ref,
) {
  const { t } = useTranslation("components");
  return (
    <input
      ref={ref}
      className="command-palette-input"
      placeholder={t("commandPalette.searchPlaceholder")}
      value={value}
      onChange={(event) => {
        setQuery(event.target.value);
        setActiveIndex(0);
      }}
      onKeyDown={onKeyDown}
      aria-label={t("commandPalette.searchLabel")}
    />
  );
});

function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return commands;
  }
  return commands.filter((command) =>
    `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`
      .toLowerCase()
      .includes(q),
  );
}

function handleCommandPaletteKeyDown({
  activeIndex,
  event,
  filteredCount,
  runIndex,
  setActiveIndex,
}: {
  activeIndex: number;
  event: React.KeyboardEvent;
  filteredCount: number;
  runIndex: (index: number) => void;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveIndex((index) => Math.min(index + 1, filteredCount - 1));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveIndex((index) => Math.max(index - 1, 0));
  } else if (event.key === "Enter") {
    event.preventDefault();
    runIndex(activeIndex);
  }
}

function CommandPaletteList({
  activeIndex,
  commands,
  listRef,
  runIndex,
  setActiveIndex,
}: {
  activeIndex: number;
  commands: Command[];
  listRef: React.RefObject<HTMLDivElement | null>;
  runIndex: (index: number) => void;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className="command-palette-list"
      ref={listRef}
      role="listbox"
      aria-label={t("commandPalette.listLabel")}
    >
      {commands.length === 0 ? (
        <p className="command-palette-empty">{t("commandPalette.noResults")}</p>
      ) : (
        commands.map((command, index) => (
          <CommandPaletteItem
            key={command.id}
            active={index === activeIndex}
            command={command}
            index={index}
            runIndex={runIndex}
            setActiveIndex={setActiveIndex}
          />
        ))
      )}
    </div>
  );
}

function CommandPaletteItem({
  active,
  command,
  index,
  runIndex,
  setActiveIndex,
}: {
  active: boolean;
  command: Command;
  index: number;
  runIndex: (index: number) => void;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`command-palette-item ${active ? "active" : ""}`}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => runIndex(index)}
    >
      <span className="command-palette-label">{command.label}</span>
      {command.hint ? (
        <span className="command-palette-hint">{command.hint}</span>
      ) : null}
    </button>
  );
}
