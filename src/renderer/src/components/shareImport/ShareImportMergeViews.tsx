import React from "react";
import { createPortal } from "react-dom";
import { DragOverlay, useDraggable, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WorkSharePreviewChapter } from "../../../../shared/shareTypes";
import { Button } from "../ui";
import { PlusIcon, TrashIcon } from "../ui/icons";
import {
  CANDIDATE_PREFIX,
  LEFT_DROPZONE_ID,
  type ActiveDrag,
  type LeftItem,
} from "./shareImportTypes";

export function ShareMergeToolbar({
  availableCount,
  busy,
  deletedCount,
  finalCount,
  onAppendAll,
}: {
  availableCount: number;
  busy: boolean;
  deletedCount: number;
  finalCount: number;
  onAppendAll: () => void;
}): React.JSX.Element {
  return (
    <div className="share-merge-toolbar">
      <div className="share-stat-row">
        <span>최종 {finalCount}개</span>
        <span className={deletedCount ? "danger-stat" : ""}>
          삭제 예정 {deletedCount}개
        </span>
        <span>남은 후보 {availableCount}개</span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onAppendAll}
        disabled={busy || availableCount === 0}
      >
        모두 추가
      </Button>
    </div>
  );
}

export function ShareFinalPane({
  activeDrag,
  busy,
  items,
  setLeftItems,
}: {
  activeDrag: ActiveDrag | null;
  busy: boolean;
  items: LeftItem[];
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
}): React.JSX.Element {
  const { isOver, setNodeRef } = useDroppable({
    id: LEFT_DROPZONE_ID,
    disabled: busy,
  });

  return (
    <div
      ref={setNodeRef}
      className={`share-pane final-pane ${isOver || activeDrag ? "drop-ready" : ""}`}
    >
      <div className="share-pane-header">
        <strong>최종 적용 목록</strong>
        <span>드래그로 순서 변경</span>
      </div>
      <SortableContext
        items={items.map((item) => item.key)}
        strategy={verticalListSortingStrategy}
      >
        <div className="share-item-list final-list">
          {items.map((item, index) => (
            <SortableFinalChapterCard
              key={item.key}
              item={item}
              index={index}
              busy={busy}
              onTitleChange={(title) =>
                setLeftItems((current) =>
                  updateLeftItemTitle(current, item.key, title),
                )
              }
              onDelete={() =>
                setLeftItems((current) =>
                  current.filter((candidate) => candidate.key !== item.key),
                )
              }
            />
          ))}
          {items.length === 0 ? (
            <p className="panel-empty">왼쪽 목록이 비어 있습니다.</p>
          ) : null}
        </div>
      </SortableContext>
    </div>
  );
}

export function ShareCandidatePane({
  availablePackageChapters,
  busy,
  onAppendPackageChapter,
}: {
  availablePackageChapters: WorkSharePreviewChapter[];
  busy: boolean;
  onAppendPackageChapter: (packageChapterId: string) => void;
}): React.JSX.Element {
  return (
    <div className="share-pane candidate-pane">
      <div className="share-pane-header">
        <strong>공유 파일 후보</strong>
        <span>{availablePackageChapters.length}개 남음</span>
      </div>
      <div className="share-item-list candidate-list">
        {availablePackageChapters.map((chapter) => (
          <CandidateChapterCard
            key={chapter.packageChapterId}
            chapter={chapter}
            busy={busy}
            onAdd={() => onAppendPackageChapter(chapter.packageChapterId)}
          />
        ))}
        {availablePackageChapters.length === 0 ? (
          <p className="panel-empty">모든 공유 화가 최종 목록에 있습니다.</p>
        ) : null}
      </div>
    </div>
  );
}

export function ShareMergeDragOverlay({
  activeDrag,
  leftItems,
}: {
  activeDrag: ActiveDrag | null;
  leftItems: LeftItem[];
}): React.JSX.Element {
  return createPortal(
    <DragOverlay>
      {activeDrag ? (
        activeDrag.type === "left" ? (
          <FinalChapterPreview
            item={activeDrag.item}
            index={resolveActiveLeftIndex(leftItems, activeDrag.item.key)}
          />
        ) : (
          <CandidatePreview chapter={activeDrag.chapter} />
        )
      ) : null}
    </DragOverlay>,
    document.body,
  );
}

export function DeletedExistingChaptersWarning({
  deletedExistingChapters,
}: {
  deletedExistingChapters: Array<{ id: string; title: string }>;
}): React.JSX.Element | null {
  if (deletedExistingChapters.length === 0) {
    return null;
  }
  return (
    <div className="share-warning-strip">
      삭제 예정:{" "}
      {deletedExistingChapters.map((chapter) => chapter.title).join(", ")}
    </div>
  );
}

function SortableFinalChapterCard({
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
  } = useSortable({
    id: item.key,
    disabled: busy,
    data: { type: "left" },
  });
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

function CandidateChapterCard({
  busy,
  chapter,
  onAdd,
}: {
  busy: boolean;
  chapter: WorkSharePreviewChapter;
  onAdd: () => void;
}): React.JSX.Element {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, isDragging } =
    useDraggable({
      id: `${CANDIDATE_PREFIX}${chapter.packageChapterId}`,
      disabled: busy,
      data: {
        type: "candidate",
        packageChapterId: chapter.packageChapterId,
      },
    });

  return (
    <div
      ref={setNodeRef}
      className={`candidate-card ${isDragging ? "dragging" : ""}`}
    >
      <button
        ref={setActivatorNodeRef}
        className="drag-handle"
        disabled={busy}
        aria-label={`${chapter.title} 최종 목록에 추가`}
        title="드래그해서 추가"
        {...attributes}
        {...listeners}
      >
        <span className="drag-grip" aria-hidden="true" />
      </button>
      <div className="candidate-main">
        <strong>{chapter.title}</strong>
        <small>{chapter.pageCount}페이지</small>
      </div>
      <button
        className="icon-add-button"
        disabled={busy}
        onClick={onAdd}
        aria-label={`${chapter.title} 추가`}
        title="추가"
      >
        <PlusIcon size={16} />
      </button>
    </div>
  );
}

function FinalChapterPreview({
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

function CandidatePreview({
  chapter,
}: {
  chapter: WorkSharePreviewChapter;
}): React.JSX.Element {
  return (
    <div className="candidate-card drag-preview">
      <span className="drag-handle preview-handle">
        <span className="drag-grip" aria-hidden="true" />
      </span>
      <div className="candidate-main">
        <strong>{chapter.title}</strong>
        <small>{chapter.pageCount}페이지</small>
      </div>
      <span className="icon-add-button preview-icon">
        <PlusIcon size={16} />
      </span>
    </div>
  );
}

function updateLeftItemTitle(
  items: LeftItem[],
  itemKey: string,
  title: string,
): LeftItem[] {
  return items.map((candidate) =>
    candidate.key === itemKey ? { ...candidate, title } : candidate,
  );
}

function resolveActiveLeftIndex(items: LeftItem[], itemKey: string): number {
  return (
    Math.max(
      0,
      items.findIndex((item) => item.key === itemKey),
    ) + 1
  );
}
