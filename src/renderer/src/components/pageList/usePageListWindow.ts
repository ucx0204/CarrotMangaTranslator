import React from "react";
import type { MangaPage } from "../../../../shared/libraryTypes";
import { useEventCallback } from "../../hooks/useEventCallback";

// Same geometry as PageListWindow.module.css, in CSS pixels (including the gap).
const ROW_PITCH = 84;
const ROW_GAP = 10;

export function usePageListWindow(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  pages: readonly MangaPage[],
  selectedPageId: string | null,
  dragging: boolean,
) {
  const enabled = pages.length > 100;
  const [range, setRange] = React.useState({ start: 0, end: 3 });
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const measure = useEventCallback(() => {
    const element = viewportRef.current;
    if (!enabled || !element) return;
    const height = element.clientHeight;
    const top = Math.min(
      element.scrollTop,
      Math.max(0, pages.length * ROW_PITCH - height),
    );
    const start = Math.max(0, Math.floor(top / ROW_PITCH) - 3);
    const end = Math.min(
      pages.length,
      Math.ceil((top + height) / ROW_PITCH) + 3,
    );
    setRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  });
  usePageViewportMeasurement(viewportRef, measure);
  const selectedIndex = React.useMemo(
    () => pages.findIndex((page) => page.id === selectedPageId),
    [pages, selectedPageId],
  );
  React.useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!enabled || !element) return;
    const height = element.clientHeight;
    if (height <= 0) return;
    if (selectedIndex >= 0) {
      const top = selectedIndex * ROW_PITCH;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_PITCH > element.scrollTop + height)
        element.scrollTop = top + ROW_PITCH - height;
    }
    measure();
  }, [
    enabled,
    measure,
    pages.length,
    selectedIndex,
    selectedPageId,
    viewportRef,
  ]);
  const { rows, after } = resolvePageWindow(
    pages,
    range,
    enabled && !dragging,
    focusedId,
  );
  return {
    enabled,
    rows,
    after,
    onScroll: measure,
    onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      setFocusedId(
        (event.target as Element).closest<HTMLElement>("[data-page-id]")
          ?.dataset.pageId ?? null,
      );
    },
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget))
        setFocusedId(null);
    },
  };
}

function resolvePageWindow(
  pages: readonly MangaPage[],
  range: { start: number; end: number },
  windowed: boolean,
  focusedId: string | null,
) {
  const start = windowed ? Math.min(range.start, pages.length) : 0;
  const end = windowed ? Math.min(range.end, pages.length) : pages.length;
  const indices = Array.from(
    { length: Math.max(0, end - start) },
    (_, i) => start + i,
  );
  const focused = pages.findIndex((page) => page.id === focusedId);
  if (windowed && focused >= 0) {
    for (const index of [focused - 1, focused, focused + 1]) {
      if (index >= 0 && index < pages.length && (index < start || index >= end))
        indices.push(index);
    }
  }
  indices.sort((a, b) => a - b);
  let previousIndex = -1;
  const rows = indices.map((index) => {
    const gap = index - previousIndex - 1;
    previousIndex = index;
    return {
      page: pages[index],
      index,
      before: gap ? gap * ROW_PITCH - ROW_GAP : 0,
    };
  });
  const remaining = pages.length - previousIndex - 1;
  return { rows, after: remaining ? remaining * ROW_PITCH - ROW_GAP : 0 };
}

function usePageViewportMeasurement(
  ref: React.RefObject<HTMLDivElement | null>,
  measure: () => void,
): void {
  React.useLayoutEffect(() => {
    measure();
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [measure, ref]);
}
