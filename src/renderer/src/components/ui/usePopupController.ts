import React from "react";
import { isTopEscapeTarget, useEscapeStackEntry } from "./popupStack";

export type PopupInitialFocus = false | "content" | string | readonly string[];

/**
 * Extends "inside the popup" beyond the root element, for popups that host a
 * portaled child surface such as a Select menu.
 */
export type PopupInsidePredicate = (target: Node, root: HTMLElement) => boolean;

export type PopupController = {
  close: (restoreFocus?: boolean) => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
  openPopup: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
  toggle: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
};

/**
 * Shared non-modal popup lifecycle: outside dismissal, Escape handling,
 * optional initial focus, and trigger focus restoration. Menu/Listbox/
 * Popover components keep their own ARIA roles and keyboard models.
 */
export function usePopupController({
  disabled = false,
  initialFocus = false,
  closeOnFocusOut = false,
  isInsidePopup,
  open,
  onOpenChange,
}: {
  disabled?: boolean;
  initialFocus?: PopupInitialFocus;
  /** Also dismiss when focus, or window activation, leaves the popup. */
  closeOnFocusOut?: boolean;
  isInsidePopup?: PopupInsidePredicate;
  open: boolean;
  /**
   * `restoreFocus` tells the owner that focus is about to move back to the
   * trigger, which matters for triggers that also open on focus.
   */
  onOpenChange: (open: boolean, options?: { restoreFocus: boolean }) => void;
}): PopupController {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback(
    (restoreFocus = false): void => {
      onOpenChange(false, { restoreFocus });
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  React.useEffect(() => {
    if (disabled && open) onOpenChange(false, { restoreFocus: false });
  }, [disabled, onOpenChange, open]);

  React.useLayoutEffect(() => {
    if (!open || initialFocus === false) return;
    const target = resolveInitialFocusTarget(contentRef.current, initialFocus);
    target?.focus();
  }, [initialFocus, open]);

  const containsTarget = React.useCallback(
    (target: EventTarget | null): boolean => {
      const root = rootRef.current;
      if (!root || !(target instanceof Node)) return false;
      if (root.contains(target)) return true;
      return Boolean(isInsidePopup?.(target, root));
    },
    [isInsidePopup],
  );
  const escapeId = useEscapeStackEntry(open);
  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!containsTarget(event.target)) close(false);
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A nested surface (e.g. a Select menu opened inside this popup) owns
      // Escape while it is open.
      if (!isTopEscapeTarget(escapeId)) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleEscape, true);
    const cleanupFocusOut = closeOnFocusOut
      ? attachFocusOutDismiss(containsTarget, close)
      : undefined;
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleEscape, true);
      cleanupFocusOut?.();
    };
  }, [close, closeOnFocusOut, containsTarget, escapeId, open]);

  return {
    close,
    contentRef,
    openPopup: React.useCallback(() => {
      if (!disabled) onOpenChange(true, { restoreFocus: false });
    }, [disabled, onOpenChange]),
    rootRef,
    toggle: React.useCallback(() => {
      if (!disabled) onOpenChange(!open, { restoreFocus: false });
    }, [disabled, onOpenChange, open]),
    triggerRef,
  };
}

/**
 * Canvas popovers also dismiss when focus leaves them or the window loses
 * activation, so a stale panel never floats over the artwork.
 */
function attachFocusOutDismiss(
  containsTarget: (target: EventTarget | null) => boolean,
  close: (restoreFocus?: boolean) => void,
): () => void {
  const handleFocusIn = (event: FocusEvent): void => {
    if (!containsTarget(event.target)) close(false);
  };
  const handleWindowBlur = (): void => close(false);
  document.addEventListener("focusin", handleFocusIn, true);
  window.addEventListener("blur", handleWindowBlur);
  return () => {
    document.removeEventListener("focusin", handleFocusIn, true);
    window.removeEventListener("blur", handleWindowBlur);
  };
}

function resolveInitialFocusTarget(
  content: HTMLDivElement | null,
  initialFocus: Exclude<PopupInitialFocus, false>,
): HTMLElement | null {
  if (initialFocus === "content") return content;
  const selectors = Array.isArray(initialFocus)
    ? initialFocus
    : [initialFocus as string];
  for (const selector of selectors) {
    const target = content?.querySelector<HTMLElement>(selector);
    if (target) return target;
  }
  return null;
}
