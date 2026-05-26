import React from "react";
import { closestCenter, DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MangaPage } from "../../../shared/types";
import { useStandardDndSensors } from "../lib/dnd";

type PageListProps = {
  pages: MangaPage[];
  selectedPageId: string | null;
  jobActive: boolean;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  onReorder: (sourcePageId: string, targetPageId: string) => void;
};

export function PageList({
  pages,
  selectedPageId,
  jobActive,
  onSelect,
  onRetranslate,
  onRemove,
  onReorder
}: PageListProps): React.JSX.Element {
  const sensors = useStandardDndSensors();
  const [activePageId, setActivePageId] = React.useState<string | null>(null);
  const pageItemRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const activePage = pages.find((page) => page.id === activePageId) ?? null;

  React.useEffect(() => {
    if (!selectedPageId) {
      return;
    }
    pageItemRefs.current[selectedPageId]?.scrollIntoView({
      block: "nearest"
    });
  }, [selectedPageId]);

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActivePageId(String(event.active.id));
  }, []);

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActivePageId(null);
      if (!event.over || event.active.id === event.over.id || jobActive) {
        return;
      }
      onReorder(String(event.active.id), String(event.over.id));
    },
    [jobActive, onReorder]
  );

  return (
    <section className="page-list">
      <div className="panel-header">
        <h2>페이지</h2>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragCancel={() => setActivePageId(null)} onDragEnd={handleDragEnd}>
        <SortableContext items={pages.map((page) => page.id)} strategy={verticalListSortingStrategy}>
          <div className={`page-list-scroll sortable-scroll ${activePageId ? "drag-active" : ""}`}>
            {pages.length ? (
              pages.map((page) => (
                <SortablePageItem
                  key={page.id}
                  page={page}
                  selected={page.id === selectedPageId}
                  disabled={jobActive}
                  onSelect={onSelect}
                  onRetranslate={onRetranslate}
                  onRemove={onRemove}
                  registerRef={(element) => {
                    pageItemRefs.current[page.id] = element;
                  }}
                />
              ))
            ) : (
              <p className="panel-empty">불러온 페이지가 없습니다.</p>
            )}
          </div>
        </SortableContext>
        <DragOverlay>{activePage ? <PageDragPreview page={activePage} selected={activePage.id === selectedPageId} /> : null}</DragOverlay>
      </DndContext>
    </section>
  );
}

function SortablePageItem({
  page,
  selected,
  disabled,
  onSelect,
  onRetranslate,
  onRemove,
  registerRef
}: {
  page: MangaPage;
  selected: boolean;
  disabled: boolean;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  registerRef: (element: HTMLDivElement | null) => void;
}): React.JSX.Element {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: page.id,
    disabled,
    data: { type: "page" }
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        registerRef(element);
      }}
      className={`page-item sortable-item ${selected ? "active" : ""} ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle compact"
        disabled={disabled}
        aria-label={`${page.name} 순서 이동`}
        title="드래그해서 이동"
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <button className="page-select" onClick={() => onSelect(page.id)}>
        <span>{page.name}</span>
      </button>
      <div className="page-side">
        {selected ? (
          <div className="page-actions">
            <button className="page-icon-button" onClick={() => onRetranslate(page.id)} disabled={disabled} aria-label={`${page.name} 재번역`} title="재번역">
              ↻
            </button>
            <button className="page-remove page-icon-button" onClick={() => onRemove(page.id)} disabled={disabled} aria-label={`${page.name} 삭제`} title="삭제">
              ×
            </button>
          </div>
        ) : (
          <span className="page-status-badge">{resolveStatusLabel(page)}</span>
        )}
      </div>
    </div>
  );
}

function PageDragPreview({ page, selected }: { page: MangaPage; selected: boolean }): React.JSX.Element {
  return (
    <div className={`page-item sortable-item drag-preview ${selected ? "active" : ""}`}>
      <span className="drag-handle compact preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="page-select preview-select">
        <span>{page.name}</span>
      </div>
      <span className="page-status-badge">{resolveStatusLabel(page)}</span>
    </div>
  );
}

function resolveStatusLabel(page: MangaPage): string {
  switch (page.analysisStatus) {
    case "completed":
      return "완료";
    case "running":
      return "진행";
    case "failed":
      return "실패";
    default:
      return "대기";
  }
}
