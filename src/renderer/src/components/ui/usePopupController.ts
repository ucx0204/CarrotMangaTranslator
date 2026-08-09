import React from "react";

export type PopupInitialFocus = false | "content" | string | readonly string[];

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
  open,
  onOpenChange,
}: {
  disabled?: boolean;
  initialFocus?: PopupInitialFocus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): PopupController {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback(
    (restoreFocus = false): void => {
      onOpenChange(false);
      if (restoreFocus) triggerRef.current?.focus();
    },
    [onOpenChange],
  );

  React.useEffect(() => {
    if (disabled && open) onOpenChange(false);
  }, [disabled, onOpenChange, open]);

  React.useLayoutEffect(() => {
    if (!open || initialFocus === false) return;
    const target = resolveInitialFocusTarget(contentRef.current, initialFocus);
    target?.focus();
  }, [initialFocus, open]);

  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleEscape, true);
    };
  }, [close, open]);

  return {
    close,
    contentRef,
    openPopup: React.useCallback(() => {
      if (!disabled) onOpenChange(true);
    }, [disabled, onOpenChange]),
    rootRef,
    toggle: React.useCallback(() => {
      if (!disabled) onOpenChange(!open);
    }, [disabled, onOpenChange, open]),
    triggerRef,
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
