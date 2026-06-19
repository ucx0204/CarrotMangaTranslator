import React from "react";

const TEXTAREA_HEIGHT_PATTERN = /^\d+(\.\d+)?px$/;

export type StickyTextareaHeight = {
  refCallback: (element: HTMLTextAreaElement | null) => void;
  reset: () => void;
};

/**
 * Keeps a textarea's manually dragged height across block changes and page
 * navigation by persisting the inline height to localStorage and reapplying it
 * whenever the element remounts. `reset` clears the stored height so the
 * textarea falls back to its default CSS height.
 */
export function useStickyTextareaHeight(
  storageKey: string,
): StickyTextareaHeight {
  const elementRef = React.useRef<HTMLTextAreaElement | null>(null);
  const observerRef = React.useRef<ResizeObserver | null>(null);

  const refCallback = React.useCallback(
    (element: HTMLTextAreaElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      elementRef.current = element;
      if (!element) {
        return;
      }
      const stored = window.localStorage.getItem(storageKey);
      if (stored && TEXTAREA_HEIGHT_PATTERN.test(stored)) {
        element.style.height = stored;
      }
      const observer = new ResizeObserver(() => {
        const height = element.style.height;
        if (height && TEXTAREA_HEIGHT_PATTERN.test(height)) {
          window.localStorage.setItem(storageKey, height);
        }
      });
      observer.observe(element);
      observerRef.current = observer;
    },
    [storageKey],
  );

  const reset = React.useCallback(() => {
    if (elementRef.current) {
      elementRef.current.style.height = "";
    }
    window.localStorage.removeItem(storageKey);
  }, [storageKey]);

  return { refCallback, reset };
}
