import React from "react";
import { useTranslation } from "react-i18next";
import {
  getLibrarySortOptions,
  LIBRARY_SORT_OPTIONS,
  type LibrarySort,
  type LibrarySortDirection,
  type LibrarySortKey,
} from "../lib/librarySort";
import { IconButton } from "./ui/IconButton";
import { SortIcon } from "./ui/icons";
import { usePopupController } from "./ui/usePopupController";

type LibrarySortMenuProps = {
  value: LibrarySort;
  onChange: (sort: LibrarySort) => void;
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
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  const [open, setOpen] = React.useState(false);
  const { close, contentRef, openPopup, rootRef, toggle, triggerRef } =
    usePopupController({
      initialFocus: "content",
      open,
      onOpenChange: setOpen,
    });

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      openPopup();
    }
  };

  const selectedLabel =
    getLibrarySortOptions(tRenderer).find((option) => option.key === value.key)
      ?.label ?? "";

  return (
    <div className={`library-sort ${open ? "open" : ""}`} ref={rootRef}>
      <IconButton
        ref={triggerRef}
        size="sm"
        label={t("library.sort.trigger", {
          criterion: selectedLabel,
          direction: t(`library.sort.direction.${value.direction}`),
        })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        <SortIcon size={16} />
      </IconButton>
      {open ? (
        <SortPopover
          menuRef={contentRef}
          value={value}
          onChange={onChange}
          onDismiss={close}
        />
      ) : null}
    </div>
  );
}

type SortPopoverProps = {
  menuRef: React.RefObject<HTMLDivElement | null>;
  value: LibrarySort;
  onChange: (sort: LibrarySort) => void;
  onDismiss: (restoreFocus?: boolean) => void;
};

function SortPopover({
  menuRef,
  value,
  onChange,
  onDismiss,
}: SortPopoverProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [activeIndex, setActiveIndex] = React.useState(() =>
    findIndexByKey(value.key),
  );

  const selectKey = (key: LibrarySortKey) =>
    onChange({ key, direction: value.direction });
  const selectDirection = (direction: LibrarySortDirection) =>
    onChange({ key: value.key, direction });

  return (
    <div
      className="library-sort-menu"
      role="menu"
      aria-label={t("library.sort.criteriaLabel")}
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
  onDismiss: (restoreFocus?: boolean) => void;
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
      event.preventDefault();
      onDismiss(true);
      return;
    case "Tab":
      window.setTimeout(() => onDismiss(false), 0);
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
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  const options = getLibrarySortOptions(tRenderer);
  return (
    <div
      className="library-sort-group"
      role="group"
      aria-label={t("library.sort.criterion")}
    >
      {options.map((option, index) => {
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
  const { t } = useTranslation("components");
  return (
    <div
      className="library-sort-direction"
      role="group"
      aria-label={t("library.sort.directionLabel")}
    >
      {(["asc", "desc"] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          className={`library-sort-dir ${value.direction === direction ? "selected" : ""}`}
          aria-pressed={value.direction === direction}
          onClick={() => onSelect(direction)}
        >
          <DirectionArrow direction={direction} />
          <span>{t(`library.sort.direction.${direction}`)}</span>
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
