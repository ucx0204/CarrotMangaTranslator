import React from "react";

const escapeStack: symbol[] = [];

/**
 * Registers an open popup surface for the lifetime of `active`.
 *
 * Escape must be consumed by the innermost open surface only. Without a shared
 * stack an outer popover that listens on the window would steal Escape from a
 * Select menu opened inside it, closing the whole panel instead of the menu.
 */
export function useEscapeStackEntry(active: boolean): symbol {
  const [id] = React.useState(() => Symbol("popup"));
  React.useEffect(() => {
    if (!active) return;
    escapeStack.push(id);
    return () => {
      const index = escapeStack.lastIndexOf(id);
      if (index >= 0) escapeStack.splice(index, 1);
    };
  }, [active, id]);
  return id;
}

/** True when no other popup surface opened after this one. */
export function isTopEscapeTarget(id: symbol): boolean {
  return escapeStack.at(-1) === id;
}
