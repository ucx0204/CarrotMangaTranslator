import React from "react";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  LibraryChapterSummary,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import { useStandardDndSensors } from "../lib/dnd";
import { filterLibraryIndex } from "../lib/libraryFilter";
import {
  readLibrarySort,
  sortLibraryIndex,
  writeLibrarySort,
  type LibrarySort,
} from "../lib/librarySort";
import { ChapterDragPreview, SortableChapterItem } from "./libraryTreeItems";
import { LibrarySortMenu } from "./LibrarySortMenu";
import { IconButton } from "./ui";
import { EditIcon } from "./ui/icons";

type LibraryTreeProps = {
  library: LibraryIndex;
  currentChapterId: string | null;
  jobActive: boolean;
  onOpenChapter: (chapterId: string) => void;
  onRenameWork: (workId: string) => void;
  onRenameChapter: (chapterId: string) => void;
  onReorderChapter: (
    workId: string,
    sourceChapterId: string,
    targetChapterId: string,
  ) => void;
};

type ActiveChapterDrag = {
  workId: string;
  chapter: LibraryChapterSummary;
};

type ChapterDragController = {
  activeDrag: ActiveChapterDrag | null;
  dragEnabled: boolean;
  handleDragCancel: () => void;
  handleDragEnd: (event: DragEndEvent) => void;
  handleDragStart: (event: DragStartEvent) => void;
  sensors: ReturnType<typeof useStandardDndSensors>;
};

export function LibraryTree({
  library,
  currentChapterId,
  jobActive,
  onOpenChapter,
  onRenameWork,
  onRenameChapter,
  onReorderChapter,
}: LibraryTreeProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = React.useState("");
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  const [sort, setSort] = React.useState<LibrarySort>(() => readLibrarySort());
  const handleSortChange = React.useCallback((next: LibrarySort) => {
    setSort(next);
    writeLibrarySort(next);
  }, []);
  const filteredLibrary = React.useMemo(
    () => filterLibraryIndex(library, deferredSearchQuery),
    [deferredSearchQuery, library],
  );
  const visibleLibrary = React.useMemo(
    () => sortLibraryIndex(filteredLibrary, sort),
    [filteredLibrary, sort],
  );
  const searchActive = searchQuery.trim().length > 0;
  const drag = useChapterDragController({
    jobActive,
    onReorderChapter,
    searchActive,
    visibleLibrary,
  });

  return (
    <section className="library-panel">
      <LibraryPanelHeader
        onSearchChange={setSearchQuery}
        onSortChange={handleSortChange}
        searchQuery={searchQuery}
        sort={sort}
      />
      <DndContext
        sensors={drag.sensors}
        collisionDetection={closestCenter}
        onDragStart={drag.handleDragStart}
        onDragCancel={drag.handleDragCancel}
        onDragEnd={drag.handleDragEnd}
      >
        <LibraryWorksList
          activeDrag={drag.activeDrag}
          currentChapterId={currentChapterId}
          dragEnabled={drag.dragEnabled}
          jobActive={jobActive}
          onOpenChapter={onOpenChapter}
          onRenameChapter={onRenameChapter}
          onRenameWork={onRenameWork}
          searchActive={searchActive}
          visibleLibrary={visibleLibrary}
        />
        <ChapterDragPortal
          activeDrag={drag.activeDrag}
          currentChapterId={currentChapterId}
        />
      </DndContext>
    </section>
  );
}

function useChapterDragController({
  jobActive,
  onReorderChapter,
  searchActive,
  visibleLibrary,
}: {
  jobActive: boolean;
  onReorderChapter: LibraryTreeProps["onReorderChapter"];
  searchActive: boolean;
  visibleLibrary: LibraryIndex;
}): ChapterDragController {
  const sensors = useStandardDndSensors();
  const [activeDrag, setActiveDrag] = React.useState<ActiveChapterDrag | null>(
    null,
  );
  const dragEnabled = !jobActive && !searchActive;
  const handleDragCancel = React.useCallback(() => setActiveDrag(null), []);
  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const workId = event.active.data.current?.workId;
      const chapterId = String(event.active.id);
      const work = visibleLibrary.works.find(
        (candidate) => candidate.id === workId,
      );
      const chapter = work?.chapters.find(
        (candidate) => candidate.id === chapterId,
      );
      if (typeof workId === "string" && chapter) {
        setActiveDrag({ workId, chapter });
      }
    },
    [visibleLibrary.works],
  );
  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      if (!event.over || event.active.id === event.over.id || !dragEnabled) {
        return;
      }
      const activeWorkId = event.active.data.current?.workId;
      const overWorkId = event.over.data.current?.workId;
      if (typeof activeWorkId !== "string" || activeWorkId !== overWorkId) {
        return;
      }
      onReorderChapter(
        activeWorkId,
        String(event.active.id),
        String(event.over.id),
      );
    },
    [dragEnabled, onReorderChapter],
  );

  return {
    activeDrag,
    dragEnabled,
    handleDragCancel,
    handleDragEnd,
    handleDragStart,
    sensors,
  };
}

function LibraryPanelHeader({
  onSearchChange,
  onSortChange,
  searchQuery,
  sort,
}: {
  onSearchChange: (query: string) => void;
  onSortChange: (sort: LibrarySort) => void;
  searchQuery: string;
  sort: LibrarySort;
}): React.JSX.Element {
  return (
    <div className="panel-header library-panel-header">
      <h2>보관함</h2>
      <label className="library-search-shell" aria-label="보관함 검색">
        <SearchIcon />
        <input
          className="library-search-input"
          type="text"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="작품/화 검색"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <LibrarySortMenu value={sort} onChange={onSortChange} />
    </div>
  );
}

function LibraryWorksList({
  activeDrag,
  currentChapterId,
  dragEnabled,
  jobActive,
  onOpenChapter,
  onRenameChapter,
  onRenameWork,
  searchActive,
  visibleLibrary,
}: {
  activeDrag: ActiveChapterDrag | null;
  currentChapterId: string | null;
  dragEnabled: boolean;
  jobActive: boolean;
  onOpenChapter: LibraryTreeProps["onOpenChapter"];
  onRenameChapter: LibraryTreeProps["onRenameChapter"];
  onRenameWork: LibraryTreeProps["onRenameWork"];
  searchActive: boolean;
  visibleLibrary: LibraryIndex;
}): React.JSX.Element {
  return (
    <div
      className={`library-scroll sortable-scroll ${activeDrag ? "drag-active" : ""}`}
    >
      {visibleLibrary.works.length ? (
        visibleLibrary.works.map((work) => (
          <LibraryWorkGroup
            key={work.id}
            currentChapterId={currentChapterId}
            dragEnabled={dragEnabled}
            jobActive={jobActive}
            onOpenChapter={onOpenChapter}
            onRenameChapter={onRenameChapter}
            onRenameWork={onRenameWork}
            work={work}
          />
        ))
      ) : (
        <p className="panel-empty">{resolveLibraryEmptyLabel(searchActive)}</p>
      )}
    </div>
  );
}

function LibraryWorkGroup({
  currentChapterId,
  dragEnabled,
  jobActive,
  onOpenChapter,
  onRenameChapter,
  onRenameWork,
  work,
}: {
  currentChapterId: string | null;
  dragEnabled: boolean;
  jobActive: boolean;
  onOpenChapter: LibraryTreeProps["onOpenChapter"];
  onRenameChapter: LibraryTreeProps["onRenameChapter"];
  onRenameWork: LibraryTreeProps["onRenameWork"];
  work: LibraryIndex["works"][number];
}): React.JSX.Element {
  return (
    <div className="work-group">
      <div className="work-row">
        <strong title={work.title}>{work.title}</strong>
        <IconButton
          size="sm"
          label={`${work.title} 이름 변경`}
          title="이름 변경"
          onClick={() => onRenameWork(work.id)}
          disabled={jobActive}
        >
          <EditIcon size={14} />
        </IconButton>
      </div>
      <SortableContext
        items={work.chapters.map((chapter) => chapter.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="chapter-list">
          {work.chapters.map((chapter) => (
            <SortableChapterItem
              key={chapter.id}
              workId={work.id}
              chapter={chapter}
              active={chapter.id === currentChapterId}
              disabled={!dragEnabled}
              jobActive={jobActive}
              onOpenChapter={onOpenChapter}
              onRenameChapter={onRenameChapter}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

function ChapterDragPortal({
  activeDrag,
  currentChapterId,
}: {
  activeDrag: ActiveChapterDrag | null;
  currentChapterId: string | null;
}): React.ReactPortal {
  return createPortal(
    <DragOverlay>
      {activeDrag ? (
        <ChapterDragPreview
          chapter={activeDrag.chapter}
          active={activeDrag.chapter.id === currentChapterId}
        />
      ) : null}
    </DragOverlay>,
    document.body,
  );
}

function resolveLibraryEmptyLabel(searchActive: boolean): string {
  return searchActive
    ? "검색 결과가 없습니다."
    : "아직 보관함에 저장된 작품이 없습니다.";
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg
      className="library-search-icon"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8.5"
        cy="8.5"
        r="5.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12.5 12.5L16.5 16.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
