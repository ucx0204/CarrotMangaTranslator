import React from "react";

export function useContextRailExpansion(chapterId: string | undefined) {
  const [contextExpanded, setContextExpanded] = React.useState(false);
  const toggleRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => setContextExpanded(false), [chapterId]);
  React.useEffect(() => {
    if (!contextExpanded) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setContextExpanded(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [contextExpanded]);

  const toggleContextExpanded = React.useCallback(
    () => setContextExpanded((expanded) => !expanded),
    [],
  );
  return { contextExpanded, toggleContextExpanded, toggleRef };
}
