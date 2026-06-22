import React from "react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { WorkSharePreviewChapter } from "../../../../shared/shareTypes";
import {
  insertItemAt,
  moveItemById,
  useStandardDndSensors,
} from "../../lib/dnd";
import { toLeftPackageItem } from "./shareImportHelpers";
import {
  CANDIDATE_PREFIX,
  LEFT_DROPZONE_ID,
  type ActiveDrag,
  type LeftItem,
} from "./shareImportTypes";

type ShareImportMergeDndInput = {
  busy: boolean;
  leftItems: LeftItem[];
  previewChapters: WorkSharePreviewChapter[];
  setActiveDrag: React.Dispatch<React.SetStateAction<ActiveDrag | null>>;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
};

export function useShareImportMergeDnd({
  busy,
  leftItems,
  previewChapters,
  setActiveDrag,
  setLeftItems,
}: ShareImportMergeDndInput) {
  const sensors = useStandardDndSensors();
  const onDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const activeDrag = resolveActiveDrag(
        String(event.active.id),
        leftItems,
        previewChapters,
      );
      if (activeDrag) {
        setActiveDrag(activeDrag);
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
        moveLeftItem(activeId, overId, setLeftItems);
        return;
      }
      if (activeType === "candidate") {
        addCandidateItem(event, overId, previewChapters, setLeftItems);
      }
    },
    [busy, previewChapters, setActiveDrag, setLeftItems],
  );
  return { onDragEnd, onDragStart, sensors };
}

function resolveActiveDrag(
  activeId: string,
  leftItems: LeftItem[],
  previewChapters: WorkSharePreviewChapter[],
): ActiveDrag | null {
  if (activeId.startsWith(CANDIDATE_PREFIX)) {
    const packageChapterId = activeId.slice(CANDIDATE_PREFIX.length);
    const chapter = previewChapters.find(
      (candidate) => candidate.packageChapterId === packageChapterId,
    );
    return chapter ? { type: "candidate", chapter } : null;
  }
  const item = leftItems.find((candidate) => candidate.key === activeId);
  return item ? { type: "left", item } : null;
}

function moveLeftItem(
  activeId: string,
  overId: string,
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
): void {
  if (overId === LEFT_DROPZONE_ID || overId.startsWith(CANDIDATE_PREFIX)) {
    return;
  }
  setLeftItems((current) =>
    moveItemById(current, activeId, overId, (item) => item.key),
  );
}

function addCandidateItem(
  event: DragEndEvent,
  overId: string,
  previewChapters: WorkSharePreviewChapter[],
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
): void {
  if (overId.startsWith(CANDIDATE_PREFIX)) {
    return;
  }
  const packageChapterId = event.active.data.current?.packageChapterId;
  if (typeof packageChapterId !== "string") {
    return;
  }
  setLeftItems((current) =>
    insertCandidateChapter(current, previewChapters, packageChapterId, overId),
  );
}

function insertCandidateChapter(
  current: LeftItem[],
  previewChapters: WorkSharePreviewChapter[],
  packageChapterId: string,
  overId: string,
): LeftItem[] {
  const chapter = previewChapters.find(
    (candidate) => candidate.packageChapterId === packageChapterId,
  );
  if (!chapter || hasPackageChapter(current, packageChapterId)) {
    return current;
  }
  return insertItemAt(
    current,
    toLeftPackageItem(chapter),
    resolveCandidateInsertIndex(current, overId),
  );
}

function hasPackageChapter(
  items: LeftItem[],
  packageChapterId: string,
): boolean {
  return items.some(
    (item) =>
      item.source === "package" && item.packageChapterId === packageChapterId,
  );
}

function resolveCandidateInsertIndex(
  current: LeftItem[],
  overId: string,
): number {
  if (overId === LEFT_DROPZONE_ID) {
    return current.length;
  }
  const overIndex = current.findIndex((item) => item.key === overId);
  return overIndex < 0 ? current.length : overIndex;
}
