import type {
  InpaintingRetouchResult,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";
import { useInpaintingRetouchActions } from "./inpaintingRetouchActions";
import {
  useClearRetouchStacks,
  useInpaintingRetouchRefs,
  useInpaintingRetouchState,
  useRetouchRefSyncEffects,
  useRetouchResetEffects,
} from "./inpaintingRetouchState";

export function useInpaintingRetouchImpl(
  options: UseInpaintingRetouchOptions,
): InpaintingRetouchResult {
  const state = useInpaintingRetouchState();
  const refs = useInpaintingRetouchRefs();
  const clearRetouchStacks = useClearRetouchStacks(state, refs);
  useRetouchRefSyncEffects(state, refs);
  useRetouchResetEffects({
    clearRetouchStacks,
    currentChapterId: options.currentChapter?.id,
    inpaintingToolActive: options.inpaintingToolActive,
    selectedPage: options.selectedPage,
    setRetouchCursorPoint: state.setRetouchCursorPoint,
    setRetouchPreview: state.setRetouchPreview,
  });

  const actions = useInpaintingRetouchActions({
    clearRetouchStacks,
    options,
    refs,
    state,
  });

  return {
    ...actions,
    inpaintingRetouchDrawingRef: refs.inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef: refs.inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef: refs.lastInpaintingRetouchPointRef,
    retouchBusy: state.retouchBusy,
    retouchCursorPoint: state.retouchCursorPoint,
    retouchPreview: state.retouchPreview,
    retouchRedoStack: state.retouchRedoStack,
    retouchUndoStack: state.retouchUndoStack,
    setRetouchCursorPoint: state.setRetouchCursorPoint,
    setRetouchPreview: state.setRetouchPreview,
  };
}
