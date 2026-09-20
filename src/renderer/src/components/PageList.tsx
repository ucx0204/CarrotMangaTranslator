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
  PageListRowCopy,
} from "./pageList/PageListRowChrome";
import { type PageStatusMode } from "./pageList/pageListStatus";
import { PageListHeader } from "./pageList/PageListHeader";
import { usePageListState } from "./pageList/usePageListState";
import {
  areSortablePageItemPropsEqual,
  buildPageListClassName,
  type SortablePageItemProps,
} from "./pageList/pageListMemo";
import { usePageThumbnailObserver } from "./pageThumbnails";
import { PageTimingDialogPortal } from "./pageList/PageTimingDialogPortal";
import { usePageListWindow } from "./pageList/usePageListWindow";
import windowStyles from "./pageList/PageListWindow.module.css";

type PageListProps = {
  collapsed: boolean;
  otherPanelCollapsed: boolean;
  pages: MangaPage[];
  selectedPageId: string | null;
  jobActive: boolean;
  lockedPageIds?: ReadonlySet<string>;
  removalLockedPageIds?: ReadonlySet<string>;
  translationBlocked?: boolean;
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
  removalLockedPageIds,
  translationBlocked = jobActive,
  statusMode = "translation",
  onSelect,
  onRetranslate,
  onRemove,
  onReorder,
  onToggleOtherPanel,
}: PageListProps): React.JSX.Element {
  const [timingOpen, setTimingOpen] = React.useState(false);
  const state = usePageListState({
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
        filter={state.filter}
        pages={pages}
        statusMode={statusMode}
        visibleCount={state.visiblePages.length}
        onFilterChange={state.setFilter}
        onOpenTiming={() => setTimingOpen(true)}
        onToggleOtherPanel={onToggleOtherPanel}
      />
      <PageListContent
        activePage={state.activePage}
        activePageId={state.activePageId}
        allPageCount={pages.length}
        collapsed={collapsed}
        disabled={jobActive}
        handleDragEnd={state.handleDragEnd}
        handleDragStart={state.handleDragStart}
        lockedPageIds={lockedPageIds}
        removalLockedPageIds={removalLockedPageIds}
        translationBlocked={translationBlocked}
        onRemove={onRemove}
        onRetranslate={onRetranslate}
        onSelect={onSelect}
        pages={state.visiblePages}
        registerPageItemRef={state.registerPageItemRef}
        selectedPageHidden={state.selectedPageHidden}
        selectedPageId={selectedPageId}
        sensors={state.sensors}
        setActivePageId={state.setActivePageId}
        statusMode={statusMode}
      />
      <PageTimingDialogPortal
        open={timingOpen}
        pages={pages}
        onClose={() => setTimingOpen(false)}
      />
    </section>
  );
}

type PageListContentProps = Parameters<typeof PageSortableContent>[0] & {
  collapsed: boolean;
  handleDragEnd: ReturnType<typeof usePageListState>["handleDragEnd"];
  handleDragStart: ReturnType<typeof usePageListState>["handleDragStart"];
  sensors: ReturnType<typeof usePageListState>["sensors"];
  setActivePageId: ReturnType<typeof usePageListState>["setActivePageId"];
};

function PageListContent({
  collapsed,
  handleDragEnd,
  handleDragStart,
  sensors,
  setActivePageId,
  ...sortableProps
}: PageListContentProps): React.JSX.Element {
  return (
    <div className="page-list-content" hidden={collapsed}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setActivePageId(null)}
        onDragEnd={handleDragEnd}
      >
        <PageSortableContent {...sortableProps} />
      </DndContext>
    </div>
  );
}

export const PageList = React.memo(PageListView);

type PageSortableContentProps = {
  activePage: MangaPage | null;
  activePageId: string | null;
  allPageCount: number;
  disabled: boolean;
  lockedPageIds: ReadonlySet<string>;
  removalLockedPageIds?: ReadonlySet<string>;
  translationBlocked: boolean;
  onRemove: (pageId: string) => void;
  onRetranslate: (pageId: string) => void;
  onSelect: (pageId: string) => void;
  pages: MangaPage[];
  registerPageItemRef: (pageId: string, element: HTMLDivElement | null) => void;
  selectedPageId: string | null;
  selectedPageHidden: boolean;
  statusMode: PageStatusMode;
};

function PageSortableContent(
  props: PageSortableContentProps,
): React.JSX.Element {
  // One observer for the whole scroll region instead of one per row.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const itemIds = React.useMemo(
    () => props.pages.map((page) => page.id),
    [props.pages],
  );
  const observeThumbnail = usePageThumbnailObserver(scrollRef, {
    rootMargin: "120px",
  });
  const windowed = usePageListWindow(
    scrollRef,
    props.pages,
    props.selectedPageId,
    Boolean(props.activePageId),
  );
  return (
    <>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div
          ref={scrollRef}
          role="list"
          onScroll={windowed.onScroll}
          onFocusCapture={windowed.onFocusCapture}
          onBlurCapture={windowed.onBlurCapture}
          className={`page-list-scroll sortable-scroll ${windowed.enabled ? windowStyles.windowed : ""} ${props.activePageId ? "drag-active" : ""}`}
        >
          {props.pages.length ? (
            renderPageRows(windowed.rows, props, observeThumbnail)
          ) : (
            <PageListEmptyNotice hasAnyPage={props.allPageCount > 0} />
          )}
          {windowed.after > 0 ? (
            <div
              aria-hidden="true"
              className={windowStyles.spacer}
              style={{ height: windowed.after }}
            />
          ) : null}
        </div>
      </SortableContext>
      {props.selectedPageHidden ? <PageListHiddenSelectionNotice /> : null}
      {createPortal(
        <PageListDragOverlay
          activePage={props.activePage}
          selectedPageId={props.selectedPageId}
          statusMode={props.statusMode}
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

const SortablePageItem = React.memo(function SortablePageItem(
  props: SortablePageItemProps,
): React.JSX.Element {
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
    id: props.page.id,
    disabled: props.disabled,
    data: { type: "page" },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition,
  };

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        props.registerRef(props.page.id, element);
      }}
      className={`page-item sortable-item ${props.selected ? "active" : ""} ${isDragging ? "dragging" : ""}`}
      data-page-id={props.page.id}
      role="listitem"
      aria-posinset={props.position}
      aria-setsize={props.total}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle compact"
        disabled={props.disabled}
        aria-label={t("pageList.moveItem", { name: props.page.name })}
        title={t("common.dragToMove")}
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <button
        className="page-select"
        onClick={() => props.onSelect(props.page.id)}
        title={props.page.name}
        aria-current={props.selected ? "page" : undefined}
      >
        <PageListThumbnail
          observeThumbnail={props.observeThumbnail}
          page={props.page}
        />
        <PageListRowCopy
          page={props.page}
          statusMode={props.statusMode}
          locked={props.locked}
        />
      </button>
      {props.statusMode === "translation" ? (
        <PageItemMenu
          removeDisabled={props.removeDisabled}
          translateDisabled={props.translateDisabled}
          onRemove={() => props.onRemove(props.page.id)}
          onRetranslate={() => props.onRetranslate(props.page.id)}
          pageName={props.page.name}
        />
      ) : null}
    </div>
  );
}, areSortablePageItemPropsEqual);

function renderPageRows(
  rows: ReturnType<typeof usePageListWindow>["rows"],
  {
    disabled,
    lockedPageIds,
    removalLockedPageIds,
    translationBlocked,
    onRemove,
    onRetranslate,
    onSelect,
    pages,
    registerPageItemRef,
    selectedPageId,
    statusMode,
  }: Omit<
    PageSortableContentProps,
    "activePage" | "activePageId" | "allPageCount" | "selectedPageHidden"
  >,
  observeThumbnail: SortablePageItemProps["observeThumbnail"],
): React.ReactNode {
  return rows.map(({ page, before, index }) => (
    <React.Fragment key={page.id}>
      {before > 0 ? (
        <div
          aria-hidden="true"
          className={windowStyles.spacer}
          style={{ height: before }}
        />
      ) : null}
      <SortablePageItem
        key={page.id}
        position={index + 1}
        total={pages.length}
        disabled={disabled}
        onRemove={onRemove}
        onRetranslate={onRetranslate}
        onSelect={onSelect}
        page={page}
        locked={lockedPageIds.has(page.id)}
        removeDisabled={removalLockedPageIds?.has(page.id) ?? disabled}
        translateDisabled={translationBlocked || lockedPageIds.has(page.id)}
        observeThumbnail={observeThumbnail}
        registerRef={registerPageItemRef}
        selected={page.id === selectedPageId}
        statusMode={statusMode}
      />
    </React.Fragment>
  ));
}
