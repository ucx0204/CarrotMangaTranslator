import React from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WorkSharePreviewChapter } from "../../../../shared/types";
import {
  insertItemAt,
  moveItemById,
  useStandardDndSensors,
} from "../../lib/dnd";
import { Button } from "../ui";
import { PlusIcon, TrashIcon } from "../ui/icons";
import { toLeftPackageItem } from "./shareImportHelpers";
import {
  CANDIDATE_PREFIX,
  LEFT_DROPZONE_ID,
  type ActiveDrag,
  type LeftItem,
} from "./shareImportTypes";

type ShareImportExistingMergeSectionProps = {
  activeDrag: ActiveDrag | null;
  appendAllPackageChapters: () => void;
  appendPackageChapter: (packageChapterId: string) => void;
  availablePackageChapters: WorkSharePreviewChapter[];
  busy: boolean;
  deletedExistingChapters: Array<{ id: string; title: string }>;
  leftItems: LeftItem[];
  previewChapters: WorkSharePreviewChapter[];
  setActiveDrag: React.Dispatch<React.SetStateAction<ActiveDrag | null>>;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
};

export function ShareImportExistingMergeSection({
  activeDrag,
  appendAllPackageChapters,
  appendPackageChapter,
  availablePackageChapters,
  busy,
  deletedExistingChapters,
  leftItems,
  previewChapters,
  setActiveDrag,
  setLeftItems,
}: ShareImportExistingMergeSectionProps): React.JSX.Element {
  const sensors = useStandardDndSensors();

  const onDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      if (id.startsWith(CANDIDATE_PREFIX)) {
        const packageChapterId = id.slice(CANDIDATE_PREFIX.length);
        const chapter = previewChapters.find(
          (candidate) => candidate.packageChapterId === packageChapterId,
        );
        if (chapter) {
          setActiveDrag({ type: "candidate", chapter });
        }
        return;
      }
      const item = leftItems.find((candidate) => candidate.key === id);
      if (item) {
        setActiveDrag({ type: "left", item });
      }
    },
    [leftItems, previewChapters, setActiveDrag],
  );

  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      const activeType = event.active.data.current?.type;
      setActiveDrag(null);
      if (!overId || busy) {
        return;
      }

      if (activeType === "left") {
        if (
          overId === LEFT_DROPZONE_ID ||
          overId.startsWith(CANDIDATE_PREFIX)
        ) {
          return;
        }
        setLeftItems((current) =>
          moveItemById(current, activeId, overId, (item) => item.key),
        );
        return;
      }

      if (activeType === "candidate") {
        if (overId.startsWith(CANDIDATE_PREFIX)) {
          return;
        }
        const packageChapterId = event.active.data.current?.packageChapterId;
        if (typeof packageChapterId !== "string") {
          return;
        }
        setLeftItems((current) => {
          const chapter = previewChapters.find(
            (candidate) => candidate.packageChapterId === packageChapterId,
          );
          if (
            !chapter ||
            current.some(
              (item) =>
                item.source === "package" &&
                item.packageChapterId === packageChapterId,
            )
          ) {
            return current;
          }
          const overIndex =
            overId === LEFT_DROPZONE_ID
              ? current.length
              : current.findIndex((item) => item.key === overId);
          return insertItemAt(
            current,
            toLeftPackageItem(chapter),
            overIndex < 0 ? current.length : overIndex,
          );
        });
      }
    },
    [busy, previewChapters, setActiveDrag, setLeftItems],
  );

  return (
    <section className="modal-section">
      <div className="share-merge-toolbar">
        <div className="share-stat-row">
          <span>최종 {leftItems.length}개</span>
          <span className={deletedExistingChapters.length ? "danger-stat" : ""}>
            삭제 예정 {deletedExistingChapters.length}개
          </span>
          <span>남은 후보 {availablePackageChapters.length}개</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={appendAllPackageChapters}
          disabled={busy || availablePackageChapters.length === 0}
        >
          모두 추가
        </Button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragCancel={() => setActiveDrag(null)}
        onDragEnd={onDragEnd}
      >
        <div className="share-merge-grid">
          <ShareFinalPane
            items={leftItems}
            busy={busy}
            activeDrag={activeDrag}
            setLeftItems={setLeftItems}
          />

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
                  onAdd={() => appendPackageChapter(chapter.packageChapterId)}
                />
              ))}
              {availablePackageChapters.length === 0 ? (
                <p className="panel-empty">
                  모든 공유 화가 최종 목록에 있습니다.
                </p>
              ) : null}
            </div>
          </div>
        </div>
        {createPortal(
          <DragOverlay>
            {activeDrag ? (
              activeDrag.type === "left" ? (
                <FinalChapterPreview
                  item={activeDrag.item}
                  index={
                    Math.max(
                      0,
                      leftItems.findIndex(
                        (item) => item.key === activeDrag.item.key,
                      ),
                    ) + 1
                  }
                />
              ) : (
                <CandidatePreview chapter={activeDrag.chapter} />
              )
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      {deletedExistingChapters.length > 0 ? (
        <div className="share-warning-strip">
          삭제 예정:{" "}
          {deletedExistingChapters.map((chapter) => chapter.title).join(", ")}
        </div>
      ) : null}
    </section>
  );
}

function ShareFinalPane({
  items,
  busy,
  activeDrag,
  setLeftItems,
}: {
  items: LeftItem[];
  busy: boolean;
  activeDrag: ActiveDrag | null;
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
                  current.map((candidate) =>
                    candidate.key === item.key
                      ? { ...candidate, title }
                      : candidate,
                  ),
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

function SortableFinalChapterCard({
  item,
  index,
  busy,
  onTitleChange,
  onDelete,
}: {
  item: LeftItem;
  index: number;
  busy: boolean;
  onTitleChange: (title: string) => void;
  onDelete: () => void;
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
  chapter,
  busy,
  onAdd,
}: {
  chapter: WorkSharePreviewChapter;
  busy: boolean;
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
  item,
  index,
}: {
  item: LeftItem;
  index: number;
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
