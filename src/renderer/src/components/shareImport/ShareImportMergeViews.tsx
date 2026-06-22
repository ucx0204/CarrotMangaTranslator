import React from "react";
import { createPortal } from "react-dom";
import { DragOverlay, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "../ui";
import { RefreshIcon, RestoreIcon } from "../ui/icons";
import {
  CandidateChapterCard,
  CandidatePreview,
  FinalChapterPreview,
  SortableFinalChapterCard,
} from "./ShareImportMergeCards";
import {
  CANDIDATE_CONTAINER_ID,
  FINAL_CONTAINER_ID,
  type ActiveDrag,
  type LeftItem,
} from "./shareImportTypes";

export function ShareMergeToolbar({
  availableCount,
  busy,
  deletedCount,
  finalCount,
  onAppendAll,
  onReset,
}: {
  availableCount: number;
  busy: boolean;
  deletedCount: number;
  finalCount: number;
  onAppendAll: () => void;
  onReset: () => void;
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
      <div className="share-merge-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={busy}
          title="기존 작품 상태로 되돌립니다"
        >
          <RefreshIcon size={14} />
          초기화
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onAppendAll}
          disabled={busy || availableCount === 0}
        >
          모두 추가
        </Button>
      </div>
    </div>
  );
}

export function ShareFinalPane({
  activeDrag,
  busy,
  items,
  onRemoveItem,
  setLeftItems,
}: {
  activeDrag: ActiveDrag | null;
  busy: boolean;
  items: LeftItem[];
  onRemoveItem: (item: LeftItem) => void;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
}): React.JSX.Element {
  const { isOver, setNodeRef } = useDroppable({
    id: FINAL_CONTAINER_ID,
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
        id={FINAL_CONTAINER_ID}
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
              onDelete={() => onRemoveItem(item)}
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
  activeDrag,
  busy,
  items,
  onAppendPackageChapter,
}: {
  activeDrag: ActiveDrag | null;
  busy: boolean;
  items: LeftItem[];
  onAppendPackageChapter: (packageChapterId: string) => void;
}): React.JSX.Element {
  const { isOver, setNodeRef } = useDroppable({
    id: CANDIDATE_CONTAINER_ID,
    disabled: busy,
  });

  return (
    <div
      ref={setNodeRef}
      className={`share-pane candidate-pane ${isOver || activeDrag ? "drop-ready" : ""}`}
    >
      <div className="share-pane-header">
        <strong>공유 파일 후보</strong>
        <span>{items.length}개 남음</span>
      </div>
      <SortableContext
        id={CANDIDATE_CONTAINER_ID}
        items={items.map((item) => item.key)}
        strategy={verticalListSortingStrategy}
      >
        <div className="share-item-list candidate-list">
          {items.map((item) => (
            <CandidateChapterCard
              key={item.key}
              item={item}
              busy={busy}
              onAdd={() =>
                item.source === "package"
                  ? onAppendPackageChapter(item.packageChapterId)
                  : undefined
              }
            />
          ))}
          {items.length === 0 ? (
            <p className="panel-empty">모든 공유 화가 최종 목록에 있습니다.</p>
          ) : null}
        </div>
      </SortableContext>
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
        activeDrag.container === "final" ? (
          <FinalChapterPreview
            item={activeDrag.item}
            index={resolveActiveLeftIndex(leftItems, activeDrag.item.key)}
          />
        ) : (
          <CandidatePreview item={activeDrag.item} />
        )
      ) : null}
    </DragOverlay>,
    document.body,
  );
}

export function DeletedExistingChaptersWarning({
  busy,
  deletedExistingChapters,
  onRestore,
}: {
  busy: boolean;
  deletedExistingChapters: Array<{ id: string; title: string }>;
  onRestore: (chapterId: string) => void;
}): React.JSX.Element | null {
  if (deletedExistingChapters.length === 0) {
    return null;
  }
  return (
    <div className="share-warning-strip">
      <span className="share-warning-label">삭제 예정</span>
      <div className="share-deleted-chips">
        {deletedExistingChapters.map((chapter) => (
          <button
            key={chapter.id}
            type="button"
            className="share-restore-chip"
            disabled={busy}
            onClick={() => onRestore(chapter.id)}
            title={`${chapter.title} 되살리기`}
          >
            <span className="share-restore-title">{chapter.title}</span>
            <RestoreIcon size={14} />
          </button>
        ))}
      </div>
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
