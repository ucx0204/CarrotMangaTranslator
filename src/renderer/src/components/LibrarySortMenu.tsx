import React from "react";
import {
  LIBRARY_SORT_OPTIONS,
  type LibrarySort,
  type LibrarySortDirection,
  type LibrarySortKey,
} from "../lib/librarySort";
import { IconButton } from "./ui";
import { SortIcon } from "./ui/icons";

type LibrarySortMenuProps = {
  value: LibrarySort;
  onChange: (sort: LibrarySort) => void;
};

const DIRECTION_LABEL: Record<LibrarySortDirection, string> = {
  asc: "오름차순",
  desc: "내림차순",
};

function findIndexByKey(key: LibrarySortKey): number {
  return Math.max(
    0,
    LIBRARY_SORT_OPTIONS.findIndex((option) => option.key === key),
  );
}

export function LibrarySortMenu({
  value,
  onChange,
}: LibrarySortMenuProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
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
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      setOpen(true);
    }
  };

  const selectedLabel =
    LIBRARY_SORT_OPTIONS.find((option) => option.key === value.key)?.label ??
    "";

  return (
    <div className={`library-sort ${open ? "open" : ""}`} ref={rootRef}>
      <IconButton
        ref={triggerRef}
        size="sm"
        label={`정렬: ${selectedLabel} ${DIRECTION_LABEL[value.direction]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <SortIcon size={16} />
      </IconButton>
      {open ? (
        <SortPopover
          value={value}
          onChange={onChange}
          onDismiss={() => {
            close();
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

type SortPopoverProps = {
  value: LibrarySort;
  onChange: (sort: LibrarySort) => void;
  onDismiss: () => void;
};

function SortPopover({
  value,
  onChange,
  onDismiss,
}: SortPopoverProps): React.JSX.Element {
  const [activeIndex, setActiveIndex] = React.useState(() =>
    findIndexByKey(value.key),
  );
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    menuRef.current?.focus();
  }, []);

  const selectKey = (key: LibrarySortKey) =>
    onChange({ key, direction: value.direction });
  const selectDirection = (direction: LibrarySortDirection) =>
    onChange({ key: value.key, direction });

  return (
    <div
      className="library-sort-menu"
      role="menu"
      aria-label="정렬 기준"
      tabIndex={-1}
      ref={menuRef}
      onKeyDown={(event) =>
        handleMenuKeyDown(event, {
          activeIndex,
          setActiveIndex,
          selectKey,
          selectDirection,
          onDismiss,
        })
      }
    >
      <SortCriteriaList
        value={value}
        activeIndex={activeIndex}
        onHover={setActiveIndex}
        onSelect={selectKey}
      />
      <SortDirectionToggle value={value} onSelect={selectDirection} />
    </div>
  );
}

type MenuKeyDownDeps = {
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  selectKey: (key: LibrarySortKey) => void;
  selectDirection: (direction: LibrarySortDirection) => void;
  onDismiss: () => void;
};

function handleMenuKeyDown(
  event: React.KeyboardEvent,
  deps: MenuKeyDownDeps,
): void {
  const { activeIndex, setActiveIndex, selectKey, selectDirection, onDismiss } =
    deps;
  const last = LIBRARY_SORT_OPTIONS.length - 1;
  switch (event.key) {
    case "Escape":
    case "Tab":
      event.preventDefault();
      onDismiss();
      return;
    case "ArrowDown":
      event.preventDefault();
      setActiveIndex((index) => Math.min(last, index + 1));
      return;
    case "ArrowUp":
      event.preventDefault();
      setActiveIndex((index) => Math.max(0, index - 1));
      return;
    case "Home":
      event.preventDefault();
      setActiveIndex(0);
      return;
    case "End":
      event.preventDefault();
      setActiveIndex(last);
      return;
    case "ArrowLeft":
      event.preventDefault();
      selectDirection("asc");
      return;
    case "ArrowRight":
      event.preventDefault();
      selectDirection("desc");
      return;
    case "Enter":
    case " ": {
      event.preventDefault();
      const option = LIBRARY_SORT_OPTIONS[activeIndex];
      if (option) {
        selectKey(option.key);
      }
      return;
    }
    default:
      return;
  }
}

function SortCriteriaList({
  value,
  activeIndex,
  onHover,
  onSelect,
}: {
  value: LibrarySort;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (key: LibrarySortKey) => void;
}): React.JSX.Element {
  return (
    <div className="library-sort-group" role="group" aria-label="기준">
      {LIBRARY_SORT_OPTIONS.map((option, index) => {
        const selected = option.key === value.key;
        return (
          <button
            key={option.key}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={[
              "library-sort-option",
              selected ? "selected" : "",
              index === activeIndex ? "active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onPointerEnter={() => onHover(index)}
            onClick={() => onSelect(option.key)}
          >
            <span className="library-sort-check" aria-hidden="true">
              {selected ? <CheckMark /> : null}
            </span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SortDirectionToggle({
  value,
  onSelect,
}: {
  value: LibrarySort;
  onSelect: (direction: LibrarySortDirection) => void;
}): React.JSX.Element {
  return (
    <div className="library-sort-direction" role="group" aria-label="정렬 방향">
      {(["asc", "desc"] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          className={`library-sort-dir ${value.direction === direction ? "selected" : ""}`}
          aria-pressed={value.direction === direction}
          onClick={() => onSelect(direction)}
        >
          <DirectionArrow direction={direction} />
          <span>{DIRECTION_LABEL[direction]}</span>
        </button>
      ))}
    </div>
  );
}

function CheckMark(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 12 4.5 4.5L19 7" />
    </svg>
  );
}

function DirectionArrow({
  direction,
}: {
  direction: LibrarySortDirection;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {direction === "asc" ? (
        <path d="M12 19V5m0 0-6 6m6-6 6 6" />
      ) : (
        <path d="M12 5v14m0 0-6-6m6 6 6-6" />
      )}
    </svg>
  );
}
