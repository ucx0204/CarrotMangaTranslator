import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LibraryChapterSummary } from "../../../shared/libraryTypes";
import { IconButton } from "./ui/IconButton";
import { EditIcon } from "./ui/icons";

type SortableChapterItemProps = {
  workId: string;
  chapter: LibraryChapterSummary;
  active: boolean;
  disabled: boolean;
  jobActive: boolean;
  onOpenChapter: (chapterId: string) => void;
  onRenameChapter: (chapterId: string) => void;
};

export function SortableChapterItem({
  workId,
  chapter,
  active,
  disabled,
  jobActive,
  onOpenChapter,
  onRenameChapter,
}: SortableChapterItemProps): React.JSX.Element {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: chapter.id,
    disabled,
    data: {
      type: "chapter",
      workId,
    },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`chapter-item sortable-item ${active ? "active" : ""} ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <ChapterDragHandle
        attributes={attributes}
        chapterTitle={chapter.title}
        disabled={disabled}
        listeners={listeners}
        setActivatorNodeRef={setActivatorNodeRef}
      />
      <ChapterSelectButton chapter={chapter} onOpenChapter={onOpenChapter} />
      <IconButton
        size="sm"
        label={`${chapter.title} 이름 변경`}
        title="이름 변경"
        onClick={() => onRenameChapter(chapter.id)}
        disabled={jobActive}
      >
        <EditIcon size={14} />
      </IconButton>
    </div>
  );
}

function ChapterDragHandle({
  attributes,
  chapterTitle,
  disabled,
  listeners,
  setActivatorNodeRef,
}: {
  attributes: ReturnType<typeof useSortable>["attributes"];
  chapterTitle: string;
  disabled: boolean;
  listeners: ReturnType<typeof useSortable>["listeners"];
  setActivatorNodeRef: ReturnType<typeof useSortable>["setActivatorNodeRef"];
}): React.JSX.Element {
  return (
    <button
      ref={setActivatorNodeRef}
      className="drag-handle compact"
      disabled={disabled}
      aria-label={`${chapterTitle} 순서 이동`}
      title={resolveChapterDragHandleTitle(disabled)}
      {...attributes}
      {...listeners}
    >
      <span className="drag-grip" aria-hidden="true" />
    </button>
  );
}

function ChapterSelectButton({
  chapter,
  onOpenChapter,
}: {
  chapter: LibraryChapterSummary;
  onOpenChapter: (chapterId: string) => void;
}): React.JSX.Element {
  return (
    <button
      className="chapter-select"
      onClick={() => onOpenChapter(chapter.id)}
      title={chapter.title}
    >
      <span>{chapter.title}</span>
      <small>
        {chapter.pageCount}페이지 · {resolveChapterStatusLabel(chapter.status)}
      </small>
    </button>
  );
}

export function ChapterDragPreview({
  chapter,
  active,
}: {
  chapter: LibraryChapterSummary;
  active: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`chapter-item sortable-item drag-preview ${active ? "active" : ""}`}
    >
      <span className="drag-handle compact preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="chapter-select preview-select" title={chapter.title}>
        <span>{chapter.title}</span>
        <small>
          {chapter.pageCount}페이지 ·{" "}
          {resolveChapterStatusLabel(chapter.status)}
        </small>
      </div>
      <span className="library-icon-button preview-edit" aria-hidden="true">
        <EditIcon size={14} />
      </span>
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

function resolveChapterDragHandleTitle(disabled: boolean): string {
  return disabled
    ? "검색 중이거나 작업 중에는 이동할 수 없습니다."
    : "드래그해서 이동";
}
