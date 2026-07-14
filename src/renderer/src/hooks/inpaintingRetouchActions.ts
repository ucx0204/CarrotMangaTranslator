import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { mangaGateway } from "../api/mangaGateway";
import { saveDirtyChanges } from "./inpaintingActionTypes";
import type {
  InpaintingRetouchResult,
  RetouchApplyTool,
  RetouchHistoryEntry,
  RetouchPoint,
  RetouchStackSetter,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";
import type {
  InpaintingRetouchRefs,
  InpaintingRetouchState,
} from "./inpaintingRetouchState";
import {
  applyRetouchRequest,
  collectReplayRetainedPaths,
  collectRetainedRetouchArtifactPaths,
  distanceBetween,
  findPageInpaintPath,
  roundRetouchPoint,
  setRetouchBusyState,
  updateChapterInpaintPath,
} from "./inpaintingRetouchHelpers";

type RetouchActions = Pick<
  InpaintingRetouchResult,
  | "appendRetouchPoint"
  | "applyRetouchPoints"
  | "clearRetouchHistory"
  | "redoRetouch"
  | "undoRetouch"
>;

type SaveChapterWithInpaintPath = (
  pageId: string,
  inpaintedImagePath?: string,
  retainedInpaintedArtifactPaths?: string[],
) => Promise<ChapterSnapshot | null>;

export function useInpaintingRetouchActions({
  clearRetouchStacks,
  options,
  refs,
  state,
}: {
  clearRetouchStacks: () => void;
  options: UseInpaintingRetouchOptions;
  refs: InpaintingRetouchRefs;
  state: InpaintingRetouchState;
}): RetouchActions {
  const saveChapterWithInpaintPath = useSaveChapterWithInpaintPath(options);
  return {
    appendRetouchPoint: useAppendRetouchPointAction(options, refs),
    applyRetouchPoints: useApplyRetouchPointsAction({
      options,
      refs,
      state,
    }),
    clearRetouchHistory: clearRetouchStacks,
    redoRetouch: useRedoRetouchAction({
      options,
      refs,
      saveChapterWithInpaintPath,
      state,
    }),
    undoRetouch: useUndoRetouchAction({
      options,
      refs,
      saveChapterWithInpaintPath,
      state,
    }),
  };
}

function useAppendRetouchPointAction(
  { inpaintingBrushRadius }: UseInpaintingRetouchOptions,
  {
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
  }: InpaintingRetouchRefs,
): RetouchActions["appendRetouchPoint"] {
  return useCallback(
    (point: RetouchPoint) => {
      const last = lastInpaintingRetouchPointRef.current;
      const minDistance = Math.max(2, inpaintingBrushRadius * 0.2);
      if (last && distanceBetween(last, point) < minDistance) {
        return null;
      }
      const nextPoint = roundRetouchPoint(point);
      lastInpaintingRetouchPointRef.current = point;
      inpaintingRetouchPointsRef.current.push(nextPoint);
      return nextPoint;
    },
    [
      inpaintingBrushRadius,
      inpaintingRetouchPointsRef,
      lastInpaintingRetouchPointRef,
    ],
  );
}

function useSaveChapterWithInpaintPath({
  clearPageImageCache,
  currentChapterRef,
  dirty,
  mergeLiveChapter,
  saveNow,
  setCurrentChapter,
}: UseInpaintingRetouchOptions): SaveChapterWithInpaintPath {
  return useCallback(
    async (pageId, inpaintedImagePath, retainedInpaintedArtifactPaths = []) => {
      await saveDirtyChanges(dirty, saveNow);
      const chapter = currentChapterRef.current;
      if (!chapter) {
        return null;
      }
      const previousChapter = chapter;
      const nextChapter = updateChapterInpaintPath(
        chapter,
        pageId,
        inpaintedImagePath,
      );
      clearPageImageCache();
      setCurrentChapter(nextChapter);
      currentChapterRef.current = nextChapter;
      try {
        const result = await mangaGateway.setPageInpaintingResult({
          chapterId: chapter.id,
          pageId,
          inpaintedImagePath: inpaintedImagePath ?? null,
          retainedInpaintedArtifactPaths,
        });
        mergeLiveChapter(result.chapter);
        return result.chapter;
      } catch (error) {
        clearPageImageCache();
        currentChapterRef.current = previousChapter;
        setCurrentChapter(previousChapter);
        throw error;
      }
    },
    [
      clearPageImageCache,
      currentChapterRef,
      dirty,
      mergeLiveChapter,
      saveNow,
      setCurrentChapter,
    ],
  );
}

function useApplyRetouchPointsAction({
  options,
  refs,
  state,
}: {
  options: UseInpaintingRetouchOptions;
  refs: InpaintingRetouchRefs;
  state: InpaintingRetouchState;
}): RetouchActions["applyRetouchPoints"] {
  const { t } = useTranslation("renderer");
  const { currentChapter, jobActive, selectedPage } = options;
  return useCallback(
    async (tool: RetouchApplyTool, points: RetouchPoint[]) => {
      if (!currentChapter || !selectedPage) {
        return;
      }
      if (points.length === 0 || jobActive || refs.retouchBusyRef.current) {
        return;
      }
      setRetouchBusyState(refs, state.setRetouchBusy, true);
      const beforePath = selectedPage.inpaintedImagePath;
      const retainedInpaintedArtifactPaths =
        collectRetainedRetouchArtifactPaths(
          refs.retouchUndoStackRef.current,
          refs.retouchRedoStackRef.current,
          [beforePath],
        );
      try {
        await saveDirtyChanges(options.dirty, options.saveNow);
        const result = await applyRetouchRequest(
          options,
          tool,
          points,
          retainedInpaintedArtifactPaths,
        );
        const afterPath = findPageInpaintPath(result.chapter, selectedPage.id);
        options.clearPageImageCache();
        options.mergeLiveChapter(result.chapter);
        const transactionId = result.historyTransaction?.transactionId;
        if (transactionId && afterPath !== beforePath) {
          options.workspaceHistory.recordImageEdit({
            label: t("workspaceHistory.retouch"),
            transactionId,
          });
        }
      } catch (error) {
        console.error(error);
        options.pushStatus(t("inpainting.retouch.applyFailed"));
      } finally {
        setRetouchBusyState(refs, state.setRetouchBusy, false);
      }
    },
    [currentChapter, jobActive, options, refs, selectedPage, state, t],
  );
}

function useUndoRetouchAction({
  options,
  refs,
  saveChapterWithInpaintPath,
  state,
}: {
  options: UseInpaintingRetouchOptions;
  refs: InpaintingRetouchRefs;
  saveChapterWithInpaintPath: SaveChapterWithInpaintPath;
  state: InpaintingRetouchState;
}): RetouchActions["undoRetouch"] {
  const { t } = useTranslation("renderer");
  return useRetouchHistoryReplayAction({
    failureMessage: t("inpainting.retouch.undoFailed"),
    jobActive: options.jobActive,
    refs,
    resolvePath: (entry) => entry.beforePath,
    saveChapterWithInpaintPath,
    setRetouchBusy: state.setRetouchBusy,
    setSourceStack: state.setRetouchUndoStack,
    setTargetStack: state.setRetouchRedoStack,
    sourceRef: refs.retouchUndoStackRef,
    successMessage: t("inpainting.retouch.undoSuccess"),
    pushStatus: options.pushStatus,
  });
}

function useRedoRetouchAction({
  options,
  refs,
  saveChapterWithInpaintPath,
  state,
}: {
  options: UseInpaintingRetouchOptions;
  refs: InpaintingRetouchRefs;
  saveChapterWithInpaintPath: SaveChapterWithInpaintPath;
  state: InpaintingRetouchState;
}): RetouchActions["redoRetouch"] {
  const { t } = useTranslation("renderer");
  return useRetouchHistoryReplayAction({
    failureMessage: t("inpainting.retouch.redoFailed"),
    jobActive: options.jobActive,
    refs,
    resolvePath: (entry) => entry.afterPath,
    saveChapterWithInpaintPath,
    setRetouchBusy: state.setRetouchBusy,
    setSourceStack: state.setRetouchRedoStack,
    setTargetStack: state.setRetouchUndoStack,
    sourceRef: refs.retouchRedoStackRef,
    successMessage: t("inpainting.retouch.redoSuccess"),
    pushStatus: options.pushStatus,
  });
}

function useRetouchHistoryReplayAction({
  failureMessage,
  jobActive,
  pushStatus,
  refs,
  resolvePath,
  saveChapterWithInpaintPath,
  setRetouchBusy,
  setSourceStack,
  setTargetStack,
  sourceRef,
  successMessage,
}: {
  failureMessage: string;
  jobActive: boolean;
  pushStatus: UseInpaintingRetouchOptions["pushStatus"];
  refs: InpaintingRetouchRefs;
  resolvePath: (entry: RetouchHistoryEntry) => string | undefined;
  saveChapterWithInpaintPath: SaveChapterWithInpaintPath;
  setRetouchBusy: InpaintingRetouchState["setRetouchBusy"];
  setSourceStack: RetouchStackSetter;
  setTargetStack: RetouchStackSetter;
  sourceRef: InpaintingRetouchRefs["retouchUndoStackRef"];
  successMessage: string;
}): () => Promise<void> {
  return useCallback(async () => {
    const entry = sourceRef.current[sourceRef.current.length - 1];
    if (!entry || jobActive || refs.retouchBusyRef.current) {
      return;
    }
    setRetouchBusyState(refs, setRetouchBusy, true);
    setSourceStack((stack) => stack.slice(0, -1));
    try {
      await saveChapterWithInpaintPath(
        entry.pageId,
        resolvePath(entry),
        collectReplayRetainedPaths(refs, entry),
      );
      setTargetStack((stack) => [...stack, entry].slice(-60));
      pushStatus(successMessage);
    } catch (error) {
      console.error(error);
      setSourceStack((stack) => [...stack, entry].slice(-60));
      pushStatus(failureMessage);
    } finally {
      setRetouchBusyState(refs, setRetouchBusy, false);
    }
  }, [
    failureMessage,
    jobActive,
    pushStatus,
    refs,
    resolvePath,
    saveChapterWithInpaintPath,
    setRetouchBusy,
    setSourceStack,
    setTargetStack,
    sourceRef,
    successMessage,
  ]);
}
