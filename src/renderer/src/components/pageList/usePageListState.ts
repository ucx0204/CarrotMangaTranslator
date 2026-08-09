import React from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { MangaPage } from "../../../../shared/libraryTypes";
import { useStandardDndSensors } from "../../lib/dnd";
import {
  matchesPageFilter,
  type PageListFilter,
  type PageStatusMode,
} from "./pageListStatus";

type PageListStateProps = {
  jobActive: boolean;
  onReorder: (sourcePageId: string, targetPageId: string) => void;
  pages: MangaPage[];
  selectedPageId: string | null;
  statusMode: PageStatusMode;
};

export function usePageListState({
  jobActive,
  onReorder,
  pages,
  selectedPageId,
  statusMode,
}: PageListStateProps) {
  const sensors = useStandardDndSensors();
  const [activePageId, setActivePageId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<PageListFilter>("all");
  const pageItemRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const registerPageItemRef = React.useCallback(
    (pageId: string, element: HTMLDivElement | null) => {
      pageItemRefs.current[pageId] = element;
    },
    [],
  );
  const activePage = pages.find((page) => page.id === activePageId) ?? null;
  const visiblePages = React.useMemo(
    () => pages.filter((page) => matchesPageFilter(page, filter, statusMode)),
    [filter, pages, statusMode],
  );
  const selectedPageHidden = Boolean(
    selectedPageId && !visiblePages.some((page) => page.id === selectedPageId),
  );
  React.useEffect(() => {
    if (!selectedPageId) return;
    pageItemRefs.current[selectedPageId]?.scrollIntoView({ block: "nearest" });
  }, [selectedPageId]);
  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActivePageId(String(event.active.id));
  }, []);
  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActivePageId(null);
      if (!event.over || event.active.id === event.over.id || jobActive) return;
      onReorder(String(event.active.id), String(event.over.id));
    },
    [jobActive, onReorder],
  );
  return {
    activePage,
    activePageId,
    filter,
    handleDragEnd,
    handleDragStart,
    registerPageItemRef,
    selectedPageHidden,
    sensors,
    setActivePageId,
    setFilter,
    visiblePages,
  };
}
