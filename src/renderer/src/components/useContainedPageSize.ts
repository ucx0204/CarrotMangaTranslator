import React from "react";
import type { MangaPage } from "../../../shared/libraryTypes";

export function useContainedPageSize(
  ref: React.RefObject<HTMLDivElement | null>,
  page: Pick<MangaPage, "width" | "height">,
): { width: number; height: number } {
  const [available, setAvailable] = React.useState({ width: 800, height: 700 });
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (): void => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setAvailable({ width: rect.width - 24, height: rect.height - 24 });
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  const scale = Math.min(
    available.width / Math.max(1, page.width),
    available.height / Math.max(1, page.height),
  );
  return {
    width: Math.max(1, Math.round(page.width * scale)),
    height: Math.max(1, Math.round(page.height * scale)),
  };
}
