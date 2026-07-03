import React from "react";
import type { GatherField, GatheredPage } from "../lib/gatherText";
import { countMatches } from "../lib/gatherTextSearch";

export type GatherTextSearch = {
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  matchCount: number;
  activeIndex: number;
  activeRef: React.RefObject<HTMLElement | null>;
  handleKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * Find-in-text state for the gather modal: tracks the query and the active
 * match, cycling through matches on Enter (Shift+Enter for previous) like a
 * browser find bar, and scrolls the active match into view.
 */
export function useGatherTextSearch(
  pages: GatheredPage[],
  field: GatherField,
): GatherTextSearch {
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const activeRef = React.useRef<HTMLElement | null>(null);

  const matchCount = React.useMemo(
    () => countMatches(pages, field, query),
    [pages, field, query],
  );

  // Jump back to the first match whenever the result set changes.
  React.useEffect(() => {
    setActiveIndex(0);
  }, [query, pages, field]);

  // Reveal the active match after it renders.
  React.useEffect(() => {
    if (matchCount > 0) {
      activeRef.current?.scrollIntoView({ block: "center" });
    }
  }, [activeIndex, query, matchCount]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || matchCount === 0) {
        return;
      }
      event.preventDefault();
      setActiveIndex((index) =>
        event.shiftKey
          ? (index - 1 + matchCount) % matchCount
          : (index + 1) % matchCount,
      );
    },
    [matchCount],
  );

  return { query, setQuery, matchCount, activeIndex, activeRef, handleKeyDown };
}
