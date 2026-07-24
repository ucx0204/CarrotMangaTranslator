import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MangaPage } from "../../../shared/libraryTypes";
import { useStandardDndSensors } from "../lib/dnd";
import { IconButton } from "./ui/IconButton";
import { CloseIcon, RefreshIcon } from "./ui/icons";

type PageStatusMode = "translation" | "inpainting";

type PageListProps = {
  pages: MangaPage[];
  selectedPageId: string | null;
  jobActive: boolean;
  statusMode?: PageStatusMode;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  onReorder: (sourcePageId: string, targetPageId: string) => void;
};

function PageListView({
  pages,
  selectedPageId,
  jobActive,
  statusMode = "translation",
  onSelect,
  onRetranslate,
  onRemove,
  onReorder,
}: PageListProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const sensors = useStandardDndSensors();
  const [activePageId, setActivePageId] = React.useState<string | null>(null);
  const pageItemRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const registerPageItemRef = React.useCallback(
    (pageId: string, element: HTMLDivElement | null) => {
      pageItemRefs.current[pageId] = element;
    },
    [],
  );
  const activePage = pages.find((page) => page.id === activePageId) ?? null;

  React.useEffect(() => {
    if (!selectedPageId) {
      return;
    }
    pageItemRefs.current[selectedPageId]?.scrollIntoView({
      block: "nearest",
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
    [jobActive, onReorder],
  );

  return (
    <section className="page-list">
      <div className="panel-header">
        <h2>{t("common.pages")}</h2>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActivePageId(null)}
        onDragEnd={handleDragEnd}
      >
        <PageSortableContent
          activePage={activePage}
          activePageId={activePageId}
          disabled={jobActive}
          onRemove={onRemove}
          onRetranslate={onRetranslate}
          onSelect={onSelect}
          pages={pages}
          registerPageItemRef={registerPageItemRef}
          selectedPageId={selectedPageId}
          statusMode={statusMode}
        />
      </DndContext>
    </section>
  );
}

export const PageList = React.memo(PageListView);

function PageSortableContent({
  activePage,
  activePageId,
  disabled,
  onRemove,
  onRetranslate,
  onSelect,
  pages,
  registerPageItemRef,
  selectedPageId,
  statusMode,
}: {
  activePage: MangaPage | null;
  activePageId: string | null;
  disabled: boolean;
  onRemove: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onSelect: (pageId: string) => void;
  pages: MangaPage[];
  registerPageItemRef: (pageId: string, element: HTMLDivElement | null) => void;
  selectedPageId: string | null;
  statusMode: PageStatusMode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <SortableContext
        items={pages.map((page) => page.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          className={`page-list-scroll sortable-scroll ${activePageId ? "drag-active" : ""}`}
        >
          {pages.length ? (
            pages.map((page) => (
              <SortablePageItem
                key={page.id}
                disabled={disabled}
                onRemove={onRemove}
                onRetranslate={onRetranslate}
                onSelect={onSelect}
                page={page}
                registerRef={registerPageItemRef}
                selected={page.id === selectedPageId}
                statusMode={statusMode}
              />
            ))
          ) : (
            <p className="panel-empty">{t("pageList.empty")}</p>
          )}
        </div>
      </SortableContext>
      {createPortal(
        <DragOverlay>
          {activePage ? (
            <PageDragPreview
              page={activePage}
              selected={activePage.id === selectedPageId}
              statusMode={statusMode}
            />
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </>
  );
}

type SortablePageItemProps = {
  page: MangaPage;
  selected: boolean;
  disabled: boolean;
  statusMode: PageStatusMode;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  registerRef: (pageId: string, element: HTMLDivElement | null) => void;
};

const SortablePageItem = React.memo(function SortablePageItem({
  page,
  selected,
  disabled,
  statusMode,
  onSelect,
  onRetranslate,
  onRemove,
  registerRef,
}: SortablePageItemProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: page.id,
    disabled,
    data: { type: "page" },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        registerRef(page.id, element);
      }}
      className={`page-item sortable-item ${selected ? "active" : ""} ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle compact"
        disabled={disabled}
        aria-label={t("pageList.moveItem", { name: page.name })}
        title={t("common.dragToMove")}
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <button
        className="page-select"
        onClick={() => onSelect(page.id)}
        title={page.name}
      >
        <span>{page.name}</span>
      </button>
      <PageItemSide
        disabled={disabled}
        onRemove={onRemove}
        onRetranslate={onRetranslate}
        page={page}
        selected={selected}
        statusMode={statusMode}
      />
    </div>
  );
}, areSortablePageItemPropsEqual);

function areSortablePageItemPropsEqual(
  previous: SortablePageItemProps,
  next: SortablePageItemProps,
): boolean {
  return (
    previous.disabled === next.disabled &&
    previous.onRemove === next.onRemove &&
    previous.onRetranslate === next.onRetranslate &&
    previous.onSelect === next.onSelect &&
    previous.registerRef === next.registerRef &&
    previous.selected === next.selected &&
    previous.statusMode === next.statusMode &&
    previous.page.id === next.page.id &&
    previous.page.name === next.page.name &&
    previous.page.analysisStatus === next.page.analysisStatus &&
    previous.page.inpaintedImagePath === next.page.inpaintedImagePath
  );
}

function PageItemSide({
  disabled,
  onRemove,
  onRetranslate,
  page,
  selected,
  statusMode,
}: {
  disabled: boolean;
  onRemove: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  page: MangaPage;
  selected: boolean;
  statusMode: PageStatusMode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (selected && statusMode === "translation") {
    return (
      <div className="page-side">
        <div className="page-actions">
          <IconButton
            size="sm"
            label={t("pageList.retranslateItem", { name: page.name })}
            title={t("pageList.retranslate")}
            onClick={() => onRetranslate(page.id)}
            disabled={disabled}
          >
            <RefreshIcon size={15} />
          </IconButton>
          <IconButton
            size="sm"
            variant="danger"
            label={t("pageList.deleteItem", { name: page.name })}
            title={t("common.delete")}
            onClick={() => onRemove(page.id)}
            disabled={disabled}
          >
            <CloseIcon size={15} />
          </IconButton>
        </div>
      </div>
    );
  }
  return (
    <div className="page-side">
      <span className="page-status-badge">
        {resolveStatusLabel(page, statusMode, t)}
      </span>
    </div>
  );
}

function PageDragPreview({
  page,
  selected,
  statusMode,
}: {
  page: MangaPage;
  selected: boolean;
  statusMode: PageStatusMode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className={`page-item sortable-item drag-preview ${selected ? "active" : ""}`}
    >
      <span className="drag-handle compact preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="page-select preview-select" title={page.name}>
        <span>{page.name}</span>
      </div>
      <span className="page-status-badge">
        {resolveStatusLabel(page, statusMode, t)}
      </span>
    </div>
  );
}

function resolveStatusLabel(
  page: MangaPage,
  statusMode: PageStatusMode,
  t: TFunction<"components">,
): string {
  if (statusMode === "inpainting") {
    return t(page.inpaintedImagePath ? "status.erased" : "status.waiting");
  }

  switch (page.analysisStatus) {
    case "completed":
      return t("status.completed");
    case "running":
      return t("status.inProgressShort");
    case "failed":
      return t("status.failed");
    default:
      return t("status.waiting");
  }
}
