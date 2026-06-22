import React from "react";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  insertItemAt,
  moveItemById,
  useStandardDndSensors,
} from "../../lib/dnd";
import {
  CANDIDATE_CONTAINER_ID,
  FINAL_CONTAINER_ID,
  type ActiveDrag,
  type LeftItem,
  type MergeContainer,
} from "./shareImportTypes";

type Lists = {
  candidateItems: LeftItem[];
  leftItems: LeftItem[];
};

type Setters = {
  setCandidateItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
};

type ShareImportMergeDndInput = {
  busy: boolean;
  candidateItems: LeftItem[];
  leftItems: LeftItem[];
  setActiveDrag: React.Dispatch<React.SetStateAction<ActiveDrag | null>>;
} & Setters;

export function useShareImportMergeDnd({
  busy,
  candidateItems,
  leftItems,
  setActiveDrag,
  setCandidateItems,
  setLeftItems,
}: ShareImportMergeDndInput) {
  const sensors = useStandardDndSensors();
  // Cross-list moves happen during onDragOver, so handlers must read the freshest
  // lists; a stale closure would corrupt indices. Keep them in a ref synced here.
  const listsRef = React.useRef<Lists>({ candidateItems, leftItems });
  React.useEffect(() => {
    listsRef.current = { candidateItems, leftItems };
  }, [candidateItems, leftItems]);

  const onDragStart = React.useCallback(
    (event: DragStartEvent) => {
      applyDragStart(event, listsRef.current, setActiveDrag);
    },
    [setActiveDrag],
  );
  const onDragOver = React.useCallback(
    (event: DragOverEvent) => {
      if (!busy) {
        applyDragOver(event, listsRef.current, {
          setCandidateItems,
          setLeftItems,
        });
      }
    },
    [busy, setCandidateItems, setLeftItems],
  );
  const onDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null);
      if (!busy) {
        applyDragEnd(event, listsRef.current, {
          setCandidateItems,
          setLeftItems,
        });
      }
    },
    [busy, setActiveDrag, setCandidateItems, setLeftItems],
  );
  const onDragCancel = React.useCallback(() => {
    setActiveDrag(null);
  }, [setActiveDrag]);

  return { onDragCancel, onDragEnd, onDragOver, onDragStart, sensors };
}

function applyDragStart(
  event: DragStartEvent,
  lists: Lists,
  setActiveDrag: React.Dispatch<React.SetStateAction<ActiveDrag | null>>,
): void {
  const activeId = String(event.active.id);
  const finalItem = lists.leftItems.find((item) => item.key === activeId);
  if (finalItem) {
    setActiveDrag({ container: "final", item: finalItem });
    return;
  }
  const candidate = lists.candidateItems.find((item) => item.key === activeId);
  if (candidate) {
    setActiveDrag({ container: "candidate", item: candidate });
  }
}

function applyDragOver(
  event: DragOverEvent,
  lists: Lists,
  setters: Setters,
): void {
  const overId = event.over ? String(event.over.id) : null;
  if (!overId) {
    return;
  }
  const activeId = String(event.active.id);
  const activeContainer = findItemContainer(activeId, lists);
  const overContainer = findOverContainer(overId, lists);
  if (!activeContainer || !overContainer || activeContainer === overContainer) {
    return;
  }
  const item = listFor(activeContainer, lists).find(
    (candidate) => candidate.key === activeId,
  );
  if (!item) {
    return;
  }
  // Existing chapters cannot become shared-file candidates.
  if (overContainer === "candidate" && item.source !== "package") {
    return;
  }
  const insertIndex = resolveInsertIndex(
    event,
    overId,
    listFor(overContainer, lists),
  );
  setterFor(
    activeContainer,
    setters,
  )((current) => current.filter((candidate) => candidate.key !== item.key));
  setterFor(
    overContainer,
    setters,
  )((current) =>
    insertItemAt(
      current.filter((candidate) => candidate.key !== item.key),
      item,
      insertIndex,
    ),
  );
}

function applyDragEnd(
  event: DragEndEvent,
  lists: Lists,
  setters: Setters,
): void {
  const overId = event.over ? String(event.over.id) : null;
  if (!overId) {
    return;
  }
  const activeId = String(event.active.id);
  const activeContainer = findItemContainer(activeId, lists);
  const overContainer = findOverContainer(overId, lists);
  if (
    !activeContainer ||
    !overContainer ||
    activeContainer !== overContainer ||
    activeId === overId
  ) {
    // Cross-container drops were already applied during onDragOver.
    return;
  }
  setterFor(
    activeContainer,
    setters,
  )((current) => moveItemById(current, activeId, overId, (item) => item.key));
}

function setterFor(
  container: MergeContainer,
  setters: Setters,
): React.Dispatch<React.SetStateAction<LeftItem[]>> {
  return container === "final"
    ? setters.setLeftItems
    : setters.setCandidateItems;
}

function listFor(container: MergeContainer, lists: Lists): LeftItem[] {
  return container === "final" ? lists.leftItems : lists.candidateItems;
}

function findItemContainer(id: string, lists: Lists): MergeContainer | null {
  if (lists.leftItems.some((item) => item.key === id)) {
    return "final";
  }
  if (lists.candidateItems.some((item) => item.key === id)) {
    return "candidate";
  }
  return null;
}

function findOverContainer(
  overId: string,
  lists: Lists,
): MergeContainer | null {
  if (overId === FINAL_CONTAINER_ID) {
    return "final";
  }
  if (overId === CANDIDATE_CONTAINER_ID) {
    return "candidate";
  }
  return findItemContainer(overId, lists);
}

function resolveInsertIndex(
  event: DragOverEvent,
  overId: string,
  targetList: LeftItem[],
): number {
  if (overId === FINAL_CONTAINER_ID || overId === CANDIDATE_CONTAINER_ID) {
    return targetList.length;
  }
  const overIndex = targetList.findIndex((item) => item.key === overId);
  if (overIndex < 0) {
    return targetList.length;
  }
  const activeRect = event.active.rect.current.translated;
  const overRect = event.over?.rect;
  const isBelow =
    activeRect && overRect
      ? activeRect.top > overRect.top + overRect.height / 2
      : false;
  return overIndex + (isBelow ? 1 : 0);
}
