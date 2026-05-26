import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

export function useStandardDndSensors(): ReturnType<typeof useSensors> {
  return useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );
}

export function moveItemById<T>(
  items: T[],
  activeId: string,
  overId: string,
  getId: (item: T) => string
): T[] {
  const oldIndex = items.findIndex((item) => getId(item) === activeId);
  const newIndex = items.findIndex((item) => getId(item) === overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, item);
  return next;
}

export function insertItemAt<T>(items: T[], item: T, index: number): T[] {
  const next = [...items];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}
