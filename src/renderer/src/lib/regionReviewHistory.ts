import type { BBox } from "../../../shared/textTypes";
import type { LetteringMaskStroke } from "../../../shared/generatedLetteringMaskTypes";
import {
  paintedSelectionBounds,
  transformSelectionStrokes,
} from "./regionReviewSelection";
type Snapshot = {
  boxes: Record<string, BBox>;
  exclusions: Record<string, LetteringMaskStroke[]>;
  groups: Record<string, string>;
  selections: Record<string, LetteringMaskStroke[]>;
};
type History = {
  present: Snapshot;
  past: Snapshot[];
  future: Snapshot[];
  gesture?: { before: Snapshot; future: Snapshot[] };
};
export type EditAction =
  | { type: "reset"; boxes: Record<string, BBox> }
  | { type: "box"; id: string; box: BBox }
  | { type: "remove"; id: string }
  | { type: "group"; id: string; group: string }
  | { type: "stroke"; id: string; stroke: LetteringMaskStroke }
  | { type: "paint"; id: string; stroke: LetteringMaskStroke }
  | { type: "begin" }
  | { type: "end" }
  | { type: "cancel" }
  | { type: "undo" }
  | { type: "redo" };
export function emptyHistory(boxes: Record<string, BBox> = {}): History {
  return {
    present: { boxes, exclusions: {}, groups: {}, selections: {} },
    past: [],
    future: [],
  };
}
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.exclusions === b.exclusions &&
    a.groups === b.groups &&
    a.selections === b.selections &&
    Object.keys(a.boxes).length === Object.keys(b.boxes).length &&
    Object.entries(a.boxes).every(([id, box]) =>
      (["x", "y", "w", "h"] as const).every(
        (key) => box[key] === b.boxes[id]?.[key],
      ),
    )
  );
}
export function reviewHistory(state: History, action: EditAction): History {
  if (action.type === "reset") return emptyHistory(action.boxes);
  if (action.type === "begin")
    return state.gesture
      ? state
      : { ...state, gesture: { before: state.present, future: state.future } };
  if (action.type === "end" || action.type === "cancel")
    return finishGesture(state, action.type === "cancel");
  if (action.type === "undo" || action.type === "redo")
    return navigateHistory(finishGesture(state, false), action.type);
  const present = editedSnapshot(state, action);
  if (sameSnapshot(state.present, present)) return state;
  return {
    ...state,
    present,
    past: state.gesture
      ? state.past
      : [...state.past.slice(-99), state.present],
    future: [],
  };
}
function finishGesture(state: History, cancel: boolean): History {
  if (!state.gesture) return state;
  const { gesture, ...rest } = state;
  if (cancel || sameSnapshot(gesture.before, state.present))
    return { ...rest, present: gesture.before, future: gesture.future };
  return { ...rest, past: [...state.past.slice(-99), gesture.before] };
}
function navigateHistory(state: History, direction: "undo" | "redo"): History {
  const stack = direction === "undo" ? state.past : state.future;
  const next = stack.at(-1);
  if (!next) return state;
  return direction === "undo"
    ? {
        present: next,
        past: state.past.slice(0, -1),
        future: [...state.future, state.present],
      }
    : {
        present: next,
        past: [...state.past, state.present],
        future: state.future.slice(0, -1),
      };
}

function editedSnapshot(
  state: History,
  action: Extract<
    EditAction,
    { type: "remove" | "group" | "box" | "stroke" | "paint" }
  >,
): Snapshot {
  if (action.type === "paint") {
    const strokes = [
      ...(state.present.selections[action.id] ?? []),
      action.stroke,
    ];
    return {
      ...state.present,
      selections: { ...state.present.selections, [action.id]: strokes },
      boxes: {
        ...state.present.boxes,
        [action.id]: paintedSelectionBounds(strokes),
      },
    };
  }
  if (action.type === "box" && state.present.boxes[action.id]) {
    if (
      (["x", "y", "w", "h"] as const).every(
        (key) => state.present.boxes[action.id][key] === action.box[key],
      )
    )
      return state.present;
    return {
      ...state.present,
      boxes: { ...state.present.boxes, [action.id]: action.box },
      exclusions: {
        ...state.present.exclusions,
        [action.id]: transformSelectionStrokes(
          state.present.exclusions[action.id] ?? [],
          state.present.boxes[action.id],
          action.box,
        ),
      },
      selections: {
        ...state.present.selections,
        [action.id]: transformSelectionStrokes(
          state.present.selections[action.id] ?? [],
          state.present.boxes[action.id],
          action.box,
        ),
      },
    };
  }

  return action.type === "remove"
    ? {
        ...state.present,
        boxes: Object.fromEntries(
          Object.entries(state.present.boxes).filter(
            ([id]) => id !== action.id,
          ),
        ),
      }
    : action.type === "group"
      ? {
          ...state.present,
          groups: { ...state.present.groups, [action.id]: action.group },
        }
      : action.type === "box"
        ? {
            ...state.present,
            boxes: { ...state.present.boxes, [action.id]: action.box },
          }
        : {
            ...state.present,
            exclusions: {
              ...state.present.exclusions,
              [action.id]: [
                ...(state.present.exclusions[action.id] ?? []),
                action.stroke,
              ],
            },
          };
}
