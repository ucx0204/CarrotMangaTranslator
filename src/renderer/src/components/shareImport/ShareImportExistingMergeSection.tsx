import React from "react";
import { closestCorners, DndContext, MeasuringStrategy } from "@dnd-kit/core";
import {
  DeletedExistingChaptersWarning,
  ShareCandidatePane,
  ShareFinalPane,
  ShareMergeDragOverlay,
  ShareMergeToolbar,
} from "./ShareImportMergeViews";
import type { ActiveDrag, LeftItem } from "./shareImportTypes";
import { useShareImportMergeDnd } from "./useShareImportMergeDnd";

type ShareImportExistingMergeSectionProps = {
  activeDrag: ActiveDrag | null;
  appendAllPackageChapters: () => void;
  appendPackageChapter: (packageChapterId: string) => void;
  availablePackageChapters: LeftItem[];
  busy: boolean;
  deletedExistingChapters: Array<{ id: string; title: string }>;
  leftItems: LeftItem[];
  removeFinalItem: (item: LeftItem) => void;
  resetMerge: () => void;
  restoreExistingChapter: (chapterId: string) => void;
  setActiveDrag: React.Dispatch<React.SetStateAction<ActiveDrag | null>>;
  setCandidateItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
};

const MEASURING = {
  droppable: { strategy: MeasuringStrategy.Always },
} as const;

export function ShareImportExistingMergeSection({
  activeDrag,
  appendAllPackageChapters,
  appendPackageChapter,
  availablePackageChapters,
  busy,
  deletedExistingChapters,
  leftItems,
  removeFinalItem,
  resetMerge,
  restoreExistingChapter,
  setActiveDrag,
  setCandidateItems,
  setLeftItems,
}: ShareImportExistingMergeSectionProps): React.JSX.Element {
  const { onDragCancel, onDragEnd, onDragOver, onDragStart, sensors } =
    useShareImportMergeDnd({
      busy,
      candidateItems: availablePackageChapters,
      leftItems,
      setActiveDrag,
      setCandidateItems,
      setLeftItems,
    });

  return (
    <section className="modal-section share-merge-section">
      <ShareMergeToolbar
        availableCount={availablePackageChapters.length}
        busy={busy}
        deletedCount={deletedExistingChapters.length}
        finalCount={leftItems.length}
        onAppendAll={appendAllPackageChapters}
        onReset={resetMerge}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        measuring={MEASURING}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragCancel={onDragCancel}
        onDragEnd={onDragEnd}
      >
        <div className="share-merge-grid">
          <ShareFinalPane
            activeDrag={activeDrag}
            busy={busy}
            items={leftItems}
            onRemoveItem={removeFinalItem}
            setLeftItems={setLeftItems}
          />
          <ShareCandidatePane
            activeDrag={activeDrag}
            busy={busy}
            items={availablePackageChapters}
            onAppendPackageChapter={appendPackageChapter}
          />
        </div>
        <ShareMergeDragOverlay activeDrag={activeDrag} leftItems={leftItems} />
      </DndContext>

      <DeletedExistingChaptersWarning
        busy={busy}
        deletedExistingChapters={deletedExistingChapters}
        onRestore={restoreExistingChapter}
      />
    </section>
  );
}
