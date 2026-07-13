import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  RetouchHistoryEntry,
  RetouchPoint,
} from "./inpaintingRetouchTypes";

export type InpaintingRetouchState = {
  retouchBusy: boolean;
  retouchRedoStack: RetouchHistoryEntry[];
  retouchUndoStack: RetouchHistoryEntry[];
  setRetouchBusy: Dispatch<SetStateAction<boolean>>;
  setRetouchRedoStack: Dispatch<SetStateAction<RetouchHistoryEntry[]>>;
  setRetouchUndoStack: Dispatch<SetStateAction<RetouchHistoryEntry[]>>;
};

export type InpaintingRetouchRefs = {
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<RetouchPoint[]>;
  lastInpaintingRetouchPointRef: MutableRefObject<RetouchPoint | null>;
  retouchBusyRef: MutableRefObject<boolean>;
  retouchRedoStackRef: MutableRefObject<RetouchHistoryEntry[]>;
  retouchUndoStackRef: MutableRefObject<RetouchHistoryEntry[]>;
};

export function useInpaintingRetouchState(): InpaintingRetouchState {
  const [retouchBusy, setRetouchBusy] = useState(false);
  const [retouchUndoStack, setRetouchUndoStack] = useState<
    RetouchHistoryEntry[]
  >([]);
  const [retouchRedoStack, setRetouchRedoStack] = useState<
    RetouchHistoryEntry[]
  >([]);

  return {
    retouchBusy,
    retouchRedoStack,
    retouchUndoStack,
    setRetouchBusy,
    setRetouchRedoStack,
    setRetouchUndoStack,
  };
}

export function useInpaintingRetouchRefs(): InpaintingRetouchRefs {
  return {
    inpaintingRetouchDrawingRef: useRef(false),
    inpaintingRetouchPointsRef: useRef<RetouchPoint[]>([]),
    lastInpaintingRetouchPointRef: useRef<RetouchPoint | null>(null),
    retouchBusyRef: useRef(false),
    retouchRedoStackRef: useRef<RetouchHistoryEntry[]>([]),
    retouchUndoStackRef: useRef<RetouchHistoryEntry[]>([]),
  };
}

export function useClearRetouchStacks(
  state: InpaintingRetouchState,
  refs: InpaintingRetouchRefs,
): () => void {
  const { retouchRedoStackRef, retouchUndoStackRef } = refs;
  const { setRetouchRedoStack, setRetouchUndoStack } = state;
  return useCallback(() => {
    retouchUndoStackRef.current = [];
    retouchRedoStackRef.current = [];
    setRetouchUndoStack([]);
    setRetouchRedoStack([]);
  }, [
    retouchRedoStackRef,
    retouchUndoStackRef,
    setRetouchRedoStack,
    setRetouchUndoStack,
  ]);
}

export function useRetouchRefSyncEffects(
  state: InpaintingRetouchState,
  refs: InpaintingRetouchRefs,
): void {
  useEffect(() => {
    refs.retouchUndoStackRef.current = state.retouchUndoStack;
  }, [refs.retouchUndoStackRef, state.retouchUndoStack]);

  useEffect(() => {
    refs.retouchRedoStackRef.current = state.retouchRedoStack;
  }, [refs.retouchRedoStackRef, state.retouchRedoStack]);

  useEffect(() => {
    refs.retouchBusyRef.current = state.retouchBusy;
  }, [refs.retouchBusyRef, state.retouchBusy]);
}

export function useRetouchResetEffects({
  clearRetouchStacks,
  currentChapterId,
}: {
  clearRetouchStacks: () => void;
  currentChapterId?: string;
}): void {
  useEffect(() => {
    clearRetouchStacks();
  }, [clearRetouchStacks, currentChapterId]);
}
