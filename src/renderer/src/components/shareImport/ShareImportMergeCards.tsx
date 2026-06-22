import React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon, TrashIcon } from "../ui/icons";
import type { LeftItem } from "./shareImportTypes";

export function SortableFinalChapterCard({
  busy,
  index,
  item,
  onDelete,
  onTitleChange,
}: {
  busy: boolean;
  index: number;
  item: LeftItem;
  onDelete: () => void;
  onTitleChange: (title: string) => void;
}): React.JSX.Element {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: busy });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`share-final-item ${item.source} ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={`${item.title} 순서 이동`}
        title="드래그해서 이동"
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <span className="item-order">{index + 1}</span>
      <span className={`source-badge ${item.source}`}>
        {item.source === "existing" ? "기존" : "공유"}
      </span>
      <input
        className="share-title-input"
        value={item.title}
        disabled={busy}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <span className="page-count-chip">{item.pageCount}p</span>
      <button
        className="icon-danger-button"
        disabled={busy}
        onClick={onDelete}
        aria-label={`${item.title} 삭제`}
        title="삭제"
      >
        <TrashIcon size={15} />
      </button>
    </div>
  );
}

export function CandidateChapterCard({
  busy,
  item,
  onAdd,
}: {
  busy: boolean;
  item: LeftItem;
  onAdd: () => void;
}): React.JSX.Element {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.key, disabled: busy });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={`candidate-card ${isDragging ? "dragging" : ""}`}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={`${item.title} 최종 목록에 추가`}
        title="드래그해서 추가"
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <div className="candidate-main">
        <strong>{item.title}</strong>
        <small>{item.pageCount}페이지</small>
      </div>
      <button
        className="icon-add-button"
        disabled={busy}
        onClick={onAdd}
        aria-label={`${item.title} 추가`}
        title="추가"
      >
        <PlusIcon size={16} />
      </button>
    </div>
  );
}

export function FinalChapterPreview({
  index,
  item,
}: {
  index: number;
  item: LeftItem;
}): React.JSX.Element {
  return (
    <div className={`share-final-item drag-preview ${item.source}`}>
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <span className="item-order">{index}</span>
      <span className={`source-badge ${item.source}`}>
        {item.source === "existing" ? "기존" : "공유"}
      </span>
      <strong className="preview-title">{item.title}</strong>
      <span className="page-count-chip">{item.pageCount}p</span>
    </div>
  );
}

export function CandidatePreview({
  item,
}: {
  item: LeftItem;
}): React.JSX.Element {
  return (
    <div className="candidate-card drag-preview">
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="candidate-main">
        <strong>{item.title}</strong>
        <small>{item.pageCount}페이지</small>
      </div>
      <span className="icon-add-button preview-icon">
        <PlusIcon size={16} />
      </span>
    </div>
  );
}
