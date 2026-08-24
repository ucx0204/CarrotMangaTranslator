import React from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { closestCenter, DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MangaPage } from "../../../shared/libraryTypes";
import {
  PageListDragOverlay,
  PageItemMenu,
  PageListThumbnail,
  PageStatus,
} from "./pageList/PageListRowChrome";
import {
  type PageListFilter,
  type PageStatusMode,
} from "./pageList/pageListStatus";
import { PageListFilterMenu } from "./pageList/PageListFilterMenu";
import { usePageListState } from "./pageList/usePageListState";
import { SidebarSectionCollapseButton } from "./SidebarSectionCollapseButton";
import {
  areSortablePageItemPropsEqual,
  buildPageListClassName,
  type SortablePageItemProps,
} from "./pageList/pageListMemo";
import { usePageThumbnailObserver } from "./pageThumbnails";

type PageListProps = {
  collapsed: boolean;
  otherPanelCollapsed: boolean;
  pages: MangaPage[];
  selectedPageId: string | null;
  jobActive: boolean;
  lockedPageIds?: ReadonlySet<string>;
  statusMode?: PageStatusMode;
  onSelect: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  onReorder: (sourcePageId: string, targetPageId: string) => void;
  onToggleOtherPanel: () => void;
};

function PageListView({
  collapsed,
  otherPanelCollapsed,
  pages,
  selectedPageId,
  jobActive,
  lockedPageIds = new Set(),
  statusMode = "translation",
  onSelect,
  onRetranslate,
  onRemove,
  onReorder,
  onToggleOtherPanel,
}: PageListProps): React.JSX.Element {
  const contentId = React.useId();
  const {
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
  } = usePageListState({
    jobActive,
    onReorder,
    pages,
    selectedPageId,
    statusMode,
  });

  return (
    <section
      className={buildPageListClassName(pages.length > 0, collapsed)}
      data-collapsed={collapsed}
      id="sidebar-page-panel"
    >
      <PageListHeader
        collapsed={collapsed}
        otherPanelCollapsed={otherPanelCollapsed}
        filter={filter}
        pages={pages}
        statusMode={statusMode}
        visibleCount={visiblePages.length}
        onFilterChange={setFilter}
        onToggleOtherPanel={onToggleOtherPanel}
      />
      <div className="page-list-content" id={contentId} hidden={collapsed}>
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
            allPageCount={pages.length}
            disabled={jobActive}
            lockedPageIds={lockedPageIds}
            onRemove={onRemove}
            onRetranslate={onRetranslate}
            onSelect={onSelect}
            pages={visiblePages}
            registerPageItemRef={registerPageItemRef}
            selectedPageId={selectedPageId}
            statusMode={statusMode}
            selectedPageHidden={selectedPageHidden}
          />
        </DndContext>
      </div>
    </section>
  );
}

function PageListHeader({
  collapsed,
  otherPanelCollapsed,
  filter,
  onFilterChange,
  onToggleOtherPanel,
  pages,
  statusMode,
  visibleCount,
}: {
  collapsed: boolean;
  otherPanelCollapsed: boolean;
  filter: PageListFilter;
  onFilterChange: (filter: PageListFilter) => void;
  onToggleOtherPanel: () => void;
  pages: MangaPage[];
  statusMode: PageStatusMode;
  visibleCount: number;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="page-list-header">
      <div className="panel-header page-list-title-row">
        <h2>{t("common.pages")}</h2>
        <div className="page-list-header-actions">
          {pages.length ? (
            <span className="page-list-visible-count">
              {t("pageList.visibleCount", {
                visible: visibleCount,
                total: pages.length,
              })}
            </span>
          ) : null}
          {pages.length && !collapsed ? (
            <PageListFilterMenu
              filter={filter}
              pages={pages}
              statusMode={statusMode}
              onChange={onFilterChange}
            />
          ) : null}
          <SidebarSectionCollapseButton
            collapsed={otherPanelCollapsed}
            controls="sidebar-library-panel"
            direction={otherPanelCollapsed ? "down" : "up"}
            onToggle={onToggleOtherPanel}
            sectionTitle={t("library.title")}
          />
        </div>
      </div>
    </div>
  );
}

export const PageList = React.memo(PageListView);

function PageSortableContent({
  activePage,
  activePageId,
  allPageCount,
  disabled,
  lockedPageIds,
  onRemove,
  onRetranslate,
  onSelect,
  pages,
  registerPageItemRef,
  selectedPageId,
  selectedPageHidden,
  statusMode,
}: {
  activePage: MangaPage | null;
  activePageId: string | null;
  allPageCount: number;
  disabled: boolean;
  lockedPageIds: ReadonlySet<string>;
  onRemove: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onSelect: (pageId: string) => void;
  pages: MangaPage[];
  registerPageItemRef: (pageId: string, element: HTMLDivElement | null) => void;
  selectedPageId: string | null;
  selectedPageHidden: boolean;
  statusMode: PageStatusMode;
}): React.JSX.Element {
  // One observer for the whole scroll region instead of one per row.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const observeThumbnail = usePageThumbnailObserver(scrollRef, {
    rootMargin: "120px",
  });
  return (
    <>
      <SortableContext
        items={pages.map((page) => page.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={scrollRef}
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
                locked={lockedPageIds.has(page.id)}
                observeThumbnail={observeThumbnail}
                registerRef={registerPageItemRef}
                selected={page.id === selectedPageId}
                statusMode={statusMode}
              />
            ))
          ) : (
            <PageListEmptyNotice hasAnyPage={allPageCount > 0} />
          )}
        </div>
      </SortableContext>
      {selectedPageHidden ? <PageListHiddenSelectionNotice /> : null}
      {createPortal(
        <PageListDragOverlay
          activePage={activePage}
          selectedPageId={selectedPageId}
          statusMode={statusMode}
        />,
        document.body,
      )}
    </>
  );
}

function PageListEmptyNotice({
  hasAnyPage,
}: {
  hasAnyPage: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <p className="panel-empty page-list-filter-empty">
      {t(hasAnyPage ? "pageList.noFilterResults" : "pageList.empty")}
    </p>
  );
}

function PageListHiddenSelectionNotice(): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <p className="page-list-filter-notice" role="status">
      {t("pageList.selectedHidden")}
    </p>
  );
}

const SortablePageItem = React.memo(function SortablePageItem({
  page,
  selected,
  disabled,
  locked,
  statusMode,
  observeThumbnail,
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
        aria-current={selected ? "page" : undefined}
      >
        <PageListThumbnail observeThumbnail={observeThumbnail} page={page} />
        <span className="page-row-copy">
          <strong>{page.name}</strong>
          <span className="page-row-meta">
            <PageStatus page={page} statusMode={statusMode} locked={locked} />
            {page.blocks.length ? (
              <span>
                {t("pageList.blockCount", { count: page.blocks.length })}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {statusMode === "translation" ? (
        <PageItemMenu
          disabled={disabled}
          onRemove={() => onRemove(page.id)}
          onRetranslate={() => onRetranslate(page.id)}
          pageName={page.name}
        />
      ) : null}
    </div>
  );
}, areSortablePageItemPropsEqual);
