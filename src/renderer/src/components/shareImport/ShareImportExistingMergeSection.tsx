import React from "react";
import { closestCenter, DndContext } from "@dnd-kit/core";
import type { WorkSharePreviewChapter } from "../../../../shared/shareTypes";
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
  const { onDragEnd, onDragStart, sensors } = useShareImportMergeDnd({
    busy,
    leftItems,
    previewChapters,
    setActiveDrag,
    setLeftItems,
  });

  return (
    <section className="modal-section">
      <ShareMergeToolbar
        availableCount={availablePackageChapters.length}
        busy={busy}
        deletedCount={deletedExistingChapters.length}
        finalCount={leftItems.length}
        onAppendAll={appendAllPackageChapters}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragCancel={() => setActiveDrag(null)}
        onDragEnd={onDragEnd}
      >
        <div className="share-merge-grid">
          <ShareFinalPane
            activeDrag={activeDrag}
            busy={busy}
            items={leftItems}
            setLeftItems={setLeftItems}
          />
          <ShareCandidatePane
            availablePackageChapters={availablePackageChapters}
            busy={busy}
            onAppendPackageChapter={appendPackageChapter}
          />
        </div>
        <ShareMergeDragOverlay activeDrag={activeDrag} leftItems={leftItems} />
      </DndContext>

      <DeletedExistingChaptersWarning
        deletedExistingChapters={deletedExistingChapters}
      />
    </section>
  );
}
