import React from "react";
import { closestCenter, DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LibraryChapterSummary, LibraryIndex } from "../../../shared/types";
import { useStandardDndSensors } from "../lib/dnd";
import { filterLibraryIndex } from "../lib/libraryFilter";

type LibraryTreeProps = {
  library: LibraryIndex;
  currentChapterId: string | null;
  jobActive: boolean;
  onOpenChapter: (chapterId: string) => void;
  onRenameWork: (workId: string) => void;
  onRenameChapter: (chapterId: string) => void;
  onReorderChapter: (workId: string, sourceChapterId: string, targetChapterId: string) => void;
};

type ActiveChapterDrag = {
  workId: string;
  chapter: LibraryChapterSummary;
};

export function LibraryTree({
  library,
  currentChapterId,
  jobActive,
  onOpenChapter,
  onRenameWork,
  onRenameChapter,
  onReorderChapter
}: LibraryTreeProps): React.JSX.Element {
  const sensors = useStandardDndSensors();
  const [activeDrag, setActiveDrag] = React.useState<ActiveChapterDrag | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const deferredSearchQuery = React.useDeferredValue(searchQuery);
  const filteredLibrary = React.useMemo(() => filterLibraryIndex(library, deferredSearchQuery), [deferredSearchQuery, library]);
  const searchActive = searchQuery.trim().length > 0;
  const dragEnabled = !jobActive && !searchActive;

  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const workId = event.active.data.current?.workId;
      const chapterId = String(event.active.id);
      const work = filteredLibrary.works.find((candidate) => candidate.id === workId);
      const chapter = work?.chapters.find((candidate) => candidate.id === chapterId);
      if (typeof workId === "string" && chapter) {
        setActiveDrag({ workId, chapter });
      }
    },
    [filteredLibrary.works]
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
      onReorderChapter(activeWorkId, String(event.active.id), String(event.over.id));
    },
    [dragEnabled, onReorderChapter]
  );

  return (
    <section className="library-panel">
      <div className="panel-header library-panel-header">
        <h2>보관함</h2>
        <label className="library-search-shell" aria-label="보관함 검색">
          <SearchIcon />
          <input
            className="library-search-input"
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="작품/화 검색"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragCancel={() => setActiveDrag(null)} onDragEnd={handleDragEnd}>
        <div className={`library-scroll sortable-scroll ${activeDrag ? "drag-active" : ""}`}>
          {filteredLibrary.works.length ? (
            filteredLibrary.works.map((work) => (
              <div key={work.id} className="work-group">
                <div className="work-row">
                  <strong title={work.title}>{work.title}</strong>
                  <button
                    className="ghost-button library-icon-button"
                    onClick={() => onRenameWork(work.id)}
                    disabled={jobActive}
                    aria-label={`${work.title} 이름 변경`}
                    title="이름 변경"
                  >
                    ✎
                  </button>
                </div>
                <SortableContext items={work.chapters.map((chapter) => chapter.id)} strategy={verticalListSortingStrategy}>
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
            ))
          ) : searchActive ? (
            <p className="panel-empty">검색 결과가 없습니다.</p>
          ) : (
            <p className="panel-empty">아직 보관함에 저장된 작품이 없습니다.</p>
          )}
        </div>
        <DragOverlay>{activeDrag ? <ChapterDragPreview chapter={activeDrag.chapter} active={activeDrag.chapter.id === currentChapterId} /> : null}</DragOverlay>
      </DndContext>
    </section>
  );
}

function SortableChapterItem({
  workId,
  chapter,
  active,
  disabled,
  jobActive,
  onOpenChapter,
  onRenameChapter
}: {
  workId: string;
  chapter: LibraryChapterSummary;
  active: boolean;
  disabled: boolean;
  jobActive: boolean;
  onOpenChapter: (chapterId: string) => void;
  onRenameChapter: (chapterId: string) => void;
}): React.JSX.Element {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: chapter.id,
    disabled,
    data: {
      type: "chapter",
      workId
    }
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div ref={setNodeRef} className={`chapter-item sortable-item ${active ? "active" : ""} ${isDragging ? "dragging" : ""}`} style={style}>
      <button
        ref={setActivatorNodeRef}
        className="drag-handle compact"
        disabled={disabled}
        aria-label={`${chapter.title} 순서 이동`}
        title={disabled ? "검색 중이거나 작업 중에는 이동할 수 없습니다." : "드래그해서 이동"}
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <button className="chapter-select" onClick={() => onOpenChapter(chapter.id)} title={chapter.title}>
        <span>{chapter.title}</span>
        <small>
          {chapter.pageCount}페이지 · {resolveChapterStatusLabel(chapter.status)}
        </small>
      </button>
      <button
        className="ghost-button library-icon-button"
        onClick={() => onRenameChapter(chapter.id)}
        disabled={jobActive}
        aria-label={`${chapter.title} 이름 변경`}
        title="이름 변경"
      >
        ✎
      </button>
    </div>
  );
}

function ChapterDragPreview({ chapter, active }: { chapter: LibraryChapterSummary; active: boolean }): React.JSX.Element {
  return (
    <div className={`chapter-item sortable-item drag-preview ${active ? "active" : ""}`}>
      <span className="drag-handle compact preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="chapter-select preview-select" title={chapter.title}>
        <span>{chapter.title}</span>
        <small>
          {chapter.pageCount}페이지 · {resolveChapterStatusLabel(chapter.status)}
        </small>
      </div>
      <span className="library-icon-button preview-edit">✎</span>
    </div>
  );
}

function resolveChapterStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "완료";
    case "running":
      return "진행 중";
    case "failed":
      return "실패";
    case "partial":
      return "부분 완료";
    default:
      return "대기";
  }
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg className="library-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12.5 12.5L16.5 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
