import React from "react";
import type {
  MenuPosition,
  SelectController,
  SelectOption,
  SelectProps,
} from "./selectTypes";
import {
  filterSelectOptions,
  resolveInitialActiveValue,
  safeDomId,
} from "./selectUtilities";
import { useSelectLifecycle } from "./useSelectLifecycle";

const AUTO_SEARCH_OPTION_COUNT = 10;

export function useSelectController({
  disabled = false,
  menuHeader,
  onValueChange,
  options,
  searchable = "auto",
  value,
  id,
}: SelectProps): SelectController {
  const reactId = React.useId().replace(/:/gu, "");
  const listboxId = `${id ?? `select-${reactId}`}-listbox`;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeValue, setActiveValue] = React.useState(value);
  const [position, setPosition] = React.useState<MenuPosition | null>(null);
  const visibleOptions = React.useMemo(
    () => filterSelectOptions(options, query),
    [options, query],
  );
  const hasSearch = resolveHasSearch(searchable, options.length);
  const close = useCloseSelect(triggerRef, setOpen, setPosition, setQuery);
  const openMenu = useOpen(disabled, options, value, setActiveValue, setOpen);
  const commit = useCommitSelect(close, onValueChange, options, value);
  const moveActive = useMoveActive(activeValue, setActiveValue, visibleOptions);
  const handleNavigationKeyDown = useSelectKeyboard({
    activeValue,
    close,
    commit,
    moveActive,
    open,
    openMenu,
  });
  const activeOptionId = resolveActiveOptionId(
    activeValue,
    listboxId,
    visibleOptions,
  );
  useSelectLifecycle({
    activeOptionId,
    activeValue,
    close,
    disabled,
    hasMenuHeader: Boolean(menuHeader),
    menuRef,
    open,
    options,
    query,
    rootRef,
    setActiveValue,
    setPosition,
    triggerRef,
    value,
    visibleOptions,
  });
  return {
    activeOptionId,
    activeValue,
    close,
    commit,
    handleNavigationKeyDown,
    hasSearch,
    listboxId,
    menuRef,
    open,
    openMenu,
    position,
    query,
    rootRef,
    setActiveValue,
    setQuery,
    triggerRef,
    value,
    visibleOptions,
  };
}

function useCloseSelect(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  setPosition: React.Dispatch<React.SetStateAction<MenuPosition | null>>,
  setQuery: React.Dispatch<React.SetStateAction<string>>,
): (restoreFocus?: boolean) => void {
  return React.useCallback(
    (restoreFocus = true): void => {
      setOpen(false);
      setQuery("");
      setPosition(null);
      if (restoreFocus) {
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [setOpen, setPosition, setQuery, triggerRef],
  );
}

function useOpen(
  disabled: boolean,
  options: readonly SelectOption[],
  value: string,
  setActiveValue: React.Dispatch<React.SetStateAction<string>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): () => void {
  return React.useCallback((): void => {
    if (disabled || options.length === 0) return;
    setActiveValue(resolveInitialActiveValue(options, value));
    setOpen(true);
  }, [disabled, options, setActiveValue, setOpen, value]);
}

function useCommitSelect(
  close: (restoreFocus?: boolean) => void,
  onValueChange: (value: string) => void,
  options: readonly SelectOption[],
  value: string,
): (value: string) => void {
  return React.useCallback(
    (nextValue: string): void => {
      const option = options.find((candidate) => candidate.value === nextValue);
      if (!option || option.disabled) return;
      if (nextValue !== value) onValueChange(nextValue);
      close();
    },
    [close, onValueChange, options, value],
  );
}

function useMoveActive(
  activeValue: string,
  setActiveValue: React.Dispatch<React.SetStateAction<string>>,
  visibleOptions: SelectOption[],
): (direction: MoveDirection) => void {
  return React.useCallback(
    (direction: MoveDirection): void => {
      const enabled = visibleOptions.filter((option) => !option.disabled);
      const nextValue = resolveMovedValue(activeValue, direction, enabled);
      if (nextValue) setActiveValue(nextValue);
    },
    [activeValue, setActiveValue, visibleOptions],
  );
}

type MoveDirection = 1 | -1 | "first" | "last";

function resolveMovedValue(
  activeValue: string,
  direction: MoveDirection,
  enabled: SelectOption[],
): string | undefined {
  if (enabled.length === 0) return undefined;
  if (direction === "first") return enabled[0]?.value;
  if (direction === "last") return enabled.at(-1)?.value;
  const currentIndex = enabled.findIndex(
    (option) => option.value === activeValue,
  );
  if (currentIndex < 0) {
    return direction === 1 ? enabled[0]?.value : enabled.at(-1)?.value;
  }
  const nextIndex =
    (currentIndex + direction + enabled.length) % enabled.length;
  return enabled[nextIndex]?.value;
}

type SelectKeyboardAction =
  | "close"
  | "commit"
  | "first"
  | "last"
  | "next"
  | "open"
  | "previous"
  | "tab";

function useSelectKeyboard({
  activeValue,
  close,
  commit,
  moveActive,
  open,
  openMenu,
}: {
  activeValue: string;
  close: (restoreFocus?: boolean) => void;
  commit: (value: string) => void;
  moveActive: (direction: MoveDirection) => void;
  open: boolean;
  openMenu: () => void;
}): (event: React.KeyboardEvent) => void {
  return React.useCallback(
    (event: React.KeyboardEvent): void => {
      const action = resolveKeyboardAction(event.key, open);
      if (!action) return;
      if (action === "tab") {
        close(false);
        return;
      }
      event.preventDefault();
      applyKeyboardAction(action, {
        activeValue,
        close,
        commit,
        moveActive,
        openMenu,
      });
    },
    [activeValue, close, commit, moveActive, open, openMenu],
  );
}

function resolveKeyboardAction(
  key: string,
  open: boolean,
): SelectKeyboardAction | null {
  if (!open) {
    return ["ArrowDown", "ArrowUp", "Enter", " "].includes(key) ? "open" : null;
  }
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (key === "Home") return "first";
  if (key === "End") return "last";
  if (key === "Enter") return "commit";
  if (key === "Escape") return "close";
  if (key === "Tab") return "tab";
  return null;
}

function applyKeyboardAction(
  action: Exclude<SelectKeyboardAction, "tab">,
  controls: {
    activeValue: string;
    close: (restoreFocus?: boolean) => void;
    commit: (value: string) => void;
    moveActive: (direction: MoveDirection) => void;
    openMenu: () => void;
  },
): void {
  if (action === "open") controls.openMenu();
  else if (action === "next") controls.moveActive(1);
  else if (action === "previous") controls.moveActive(-1);
  else if (action === "first") controls.moveActive("first");
  else if (action === "last") controls.moveActive("last");
  else if (action === "commit") controls.commit(controls.activeValue);
  else controls.close();
}

function resolveHasSearch(
  searchable: boolean | "auto",
  optionCount: number,
): boolean {
  return (
    searchable === true ||
    (searchable === "auto" && optionCount >= AUTO_SEARCH_OPTION_COUNT)
  );
}

function resolveActiveOptionId(
  activeValue: string,
  listboxId: string,
  visibleOptions: SelectOption[],
): string | undefined {
  return visibleOptions.some((option) => option.value === activeValue)
    ? `${listboxId}-${safeDomId(activeValue)}`
    : undefined;
}
