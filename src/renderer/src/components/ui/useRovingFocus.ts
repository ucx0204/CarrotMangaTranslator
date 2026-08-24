import React from "react";

export type RovingFocus = {
  register: (index: number) => (element: HTMLButtonElement | null) => void;
  handleKeyDown: (
    index: number,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => void;
};

/**
 * Arrow/Home/End navigation for a single-select button group where only the
 * selected item is a tab stop. Shared by Tabs and SegmentedControl so the two
 * ARIA patterns cannot drift apart in keyboard behavior.
 */
export function useRovingFocus({
  count,
  disabled = false,
  onActivate,
}: {
  count: number;
  disabled?: boolean;
  onActivate: (index: number) => void;
}): RovingFocus {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const register = React.useCallback(
    (index: number) =>
      (element: HTMLButtonElement | null): void => {
        refs.current[index] = element;
      },
    [],
  );

  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (disabled) return;
    const nextIndex = resolveNextIndex(event.key, index, count);
    if (nextIndex === null) return;
    event.preventDefault();
    onActivate(nextIndex);
    refs.current[nextIndex]?.focus();
  };

  return { register, handleKeyDown };
}

function resolveNextIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  if (count === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (index + 1) % count;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (index - 1 + count) % count;
  }
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
