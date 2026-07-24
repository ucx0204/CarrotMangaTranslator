import React from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { DragOverlay, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "../ui/Button";
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
  const { t } = useTranslation("components");
  return (
    <div className="share-merge-toolbar">
      <div className="share-stat-row">
        <span>{t("shareImport.stats.final", { count: finalCount })}</span>
        <span className={deletedCount ? "danger-stat" : ""}>
          {t("shareImport.stats.toDelete", { count: deletedCount })}
        </span>
        <span>
          {t("shareImport.stats.remainingCandidates", {
            count: availableCount,
          })}
        </span>
      </div>
      <div className="share-merge-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={busy}
          title={t("shareImport.resetTitle")}
        >
          <RefreshIcon size={14} />
          {t("common.reset")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onAppendAll}
          disabled={busy || availableCount === 0}
        >
          {t("shareImport.addAll")}
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
  const { t } = useTranslation("components");
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
        <strong>{t("shareImport.finalList")}</strong>
        <span>{t("shareImport.dragToReorder")}</span>
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
            <p className="panel-empty">{t("shareImport.finalListEmpty")}</p>
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
  const { t } = useTranslation("components");
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
        <strong>{t("shareImport.candidates")}</strong>
        <span>{t("shareImport.remaining", { count: items.length })}</span>
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
            <p className="panel-empty">{t("shareImport.allChaptersInFinal")}</p>
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
  const { t } = useTranslation("components");
  if (deletedExistingChapters.length === 0) {
    return null;
  }
  return (
    <div className="share-warning-strip">
      <span className="share-warning-label">{t("shareImport.toDelete")}</span>
      <div className="share-deleted-chips">
        {deletedExistingChapters.map((chapter) => (
          <button
            key={chapter.id}
            type="button"
            className="share-restore-chip"
            disabled={busy}
            onClick={() => onRestore(chapter.id)}
            title={t("shareImport.restoreItem", { title: chapter.title })}
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
