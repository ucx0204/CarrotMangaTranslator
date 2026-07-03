import React from "react";
import { splitHighlightSegments } from "../lib/gatherTextSearch";

type HighlightedTextProps = {
  text: string;
  query: string;
  /** Global ordinal of this line's first match; ordinals run start, start+1… */
  startOrdinal: number;
  activeIndex: number;
  activeRef: React.RefObject<HTMLElement | null>;
};

/**
 * Renders `text` with case-insensitive occurrences of `query` wrapped in
 * <mark>. Match ordinals are derived purely from `startOrdinal` (no shared
 * mutable counter) so they stay stable across re-renders and StrictMode.
 */
export function HighlightedText({
  text,
  query,
  startOrdinal,
  activeIndex,
  activeRef,
}: HighlightedTextProps): React.JSX.Element {
  if (!query) {
    return <>{text}</>;
  }
  let matchIndex = 0;
  return (
    <>
      {splitHighlightSegments(text, query).map((segment, index) => {
        if (!segment.match) {
          return <React.Fragment key={index}>{segment.text}</React.Fragment>;
        }
        const ordinal = startOrdinal + matchIndex;
        matchIndex += 1;
        const active = ordinal === activeIndex;
        return (
          <mark
            key={index}
            ref={active ? activeRef : undefined}
            className={`gather-text-mark ${active ? "active" : ""}`}
          >
            {segment.text}
          </mark>
        );
      })}
    </>
  );
}
