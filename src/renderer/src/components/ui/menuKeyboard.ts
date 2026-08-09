import type React from "react";

type MenuKeyboardOptions = {
  onEscape?: () => void;
  onTab?: () => void;
};

/** Shared roving-focus behavior for DOM-focused menu items. */
export function handleMenuKeyboardNavigation(
  event: React.KeyboardEvent<HTMLElement>,
  { onEscape, onTab }: MenuKeyboardOptions = {},
): boolean {
  if (event.key === "Escape") {
    if (!onEscape) return false;
    event.preventDefault();
    onEscape();
    return true;
  }
  if (event.key === "Tab") {
    if (onTab) window.setTimeout(onTab, 0);
    return false;
  }

  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not([disabled]):not([aria-disabled="true"])',
    ),
  );
  if (items.length === 0) return false;

  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  const nextIndex = resolveMenuTargetIndex(
    event.key,
    currentIndex,
    items.length,
  );
  if (nextIndex === null) return false;
  event.preventDefault();
  items[nextIndex]?.focus();
  return true;
}

function resolveMenuTargetIndex(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  switch (key) {
    case "ArrowDown":
      return (currentIndex + 1 + itemCount) % itemCount;
    case "ArrowUp":
      return (currentIndex - 1 + itemCount) % itemCount;
    case "Home":
      return 0;
    case "End":
      return itemCount - 1;
    default:
      return null;
  }
}
