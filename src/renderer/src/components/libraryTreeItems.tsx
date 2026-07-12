import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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
        label={t("library.renameItem", { title: chapter.title })}
        title={t("common.rename")}
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
  const { t } = useTranslation("components");
  return (
    <button
      ref={setActivatorNodeRef}
      className="drag-handle compact"
      disabled={disabled}
      aria-label={t("library.moveItem", { title: chapterTitle })}
      title={t(disabled ? "library.moveDisabled" : "common.dragToMove")}
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
  const { t } = useTranslation("components");
  return (
    <button
      className="chapter-select"
      onClick={() => onOpenChapter(chapter.id)}
      title={chapter.title}
    >
      <span>{chapter.title}</span>
      <small>
        {t("common.pageCount", { count: chapter.pageCount })} ·{" "}
        {resolveChapterStatusLabel(chapter.status, t)}
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
  const { t } = useTranslation("components");
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
          {t("common.pageCount", { count: chapter.pageCount })} ·{" "}
          {resolveChapterStatusLabel(chapter.status, t)}
        </small>
      </div>
      <span className="library-icon-button preview-edit" aria-hidden="true">
        <EditIcon size={14} />
      </span>
    </div>
  );
}

function resolveChapterStatusLabel(
  status: string,
  t: TFunction<"components">,
): string {
  switch (status) {
    case "completed":
      return t("status.completed");
    case "running":
      return t("common.inProgress");
    case "failed":
      return t("status.failed");
    case "partial":
      return t("status.partiallyCompleted");
    default:
      return t("status.waiting");
  }
}
