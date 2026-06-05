import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/types";

export type RetouchPreviewState = {
  mode: "brush" | "eraser" | "mask";
  points: Array<{ x: number; y: number }>;
  radiusPx: number;
  color: string;
};

export type RetouchHistoryEntry = {
  pageId: string;
  beforePath?: string;
  afterPath?: string;
};

type RetouchDrawTool = "brush" | "eraser" | "mask";
type RetouchApplyTool = "brush" | "eraser";

type UseInpaintingRetouchOptions = {
  clearPageImageCache: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  inpaintingBrushRadius: number;
  inpaintingPaintColor: string;
  inpaintingToolActive: boolean;
  jobActive: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  pushStatus: (line: string) => void;
  selectedPage: MangaPage | null;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
};

function collectRetainedRetouchArtifactPaths(...sources: Array<RetouchHistoryEntry[] | Array<string | undefined> | undefined>): string[] {
  const retainedPaths = new Set<string>();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const item of source) {
      if (typeof item === "string") {
        retainedPaths.add(item);
      } else if (item) {
        if (item.beforePath) {
          retainedPaths.add(item.beforePath);
        }
        if (item.afterPath) {
          retainedPaths.add(item.afterPath);
        }
      }
    }
  }
  return Array.from(retainedPaths);
}

export function useInpaintingRetouch({
  clearPageImageCache,
  currentChapter,
  currentChapterRef,
  inpaintingBrushRadius,
  inpaintingPaintColor,
  inpaintingToolActive,
  jobActive,
  mergeLiveChapter,
  pushStatus,
  selectedPage,
  setCurrentChapter
}: UseInpaintingRetouchOptions): {
  appendRetouchPoint: (point: { x: number; y: number }, tool?: RetouchDrawTool) => void;
  applyRetouchPoints: (tool: RetouchApplyTool, points: Array<{ x: number; y: number }>) => Promise<void>;
  clearRetouchHistory: () => void;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<Array<{ x: number; y: number }>>;
  lastInpaintingRetouchPointRef: MutableRefObject<{ x: number; y: number } | null>;
  redoRetouch: () => Promise<void>;
  retouchBusy: boolean;
  retouchCursorPoint: { x: number; y: number } | null;
  retouchPreview: RetouchPreviewState | null;
  retouchRedoStack: RetouchHistoryEntry[];
  retouchUndoStack: RetouchHistoryEntry[];
  setRetouchCursorPoint: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setRetouchPreview: Dispatch<SetStateAction<RetouchPreviewState | null>>;
  undoRetouch: () => Promise<void>;
} {
  const [retouchCursorPoint, setRetouchCursorPoint] = useState<{ x: number; y: number } | null>(null);
  const [retouchPreview, setRetouchPreview] = useState<RetouchPreviewState | null>(null);
  const [retouchBusy, setRetouchBusy] = useState(false);
  const [retouchUndoStack, setRetouchUndoStack] = useState<RetouchHistoryEntry[]>([]);
  const [retouchRedoStack, setRetouchRedoStack] = useState<RetouchHistoryEntry[]>([]);
  const inpaintingRetouchDrawingRef = useRef(false);
  const inpaintingRetouchPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const lastInpaintingRetouchPointRef = useRef<{ x: number; y: number } | null>(null);
  const retouchBusyRef = useRef(false);
  const retouchUndoStackRef = useRef<RetouchHistoryEntry[]>([]);
  const retouchRedoStackRef = useRef<RetouchHistoryEntry[]>([]);

  useEffect(() => {
    retouchUndoStackRef.current = retouchUndoStack;
  }, [retouchUndoStack]);

  useEffect(() => {
    retouchRedoStackRef.current = retouchRedoStack;
  }, [retouchRedoStack]);

  useEffect(() => {
    retouchBusyRef.current = retouchBusy;
  }, [retouchBusy]);

  useEffect(() => {
    clearRetouchStacks();
  }, [currentChapter?.id]);

  useEffect(() => {
    if (!selectedPage) {
      setRetouchCursorPoint(null);
      setRetouchPreview(null);
    }
  }, [selectedPage]);

  useEffect(() => {
    if (!inpaintingToolActive) {
      setRetouchCursorPoint(null);
      setRetouchPreview(null);
    }
  }, [inpaintingToolActive]);

  const appendRetouchPoint = useCallback(
    (point: { x: number; y: number }, tool?: RetouchDrawTool) => {
      const last = lastInpaintingRetouchPointRef.current;
      const minDistance = Math.max(2, inpaintingBrushRadius * 0.2);
      if (last) {
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        if (Math.sqrt(dx * dx + dy * dy) < minDistance) {
          return;
        }
      }
      lastInpaintingRetouchPointRef.current = point;
      inpaintingRetouchPointsRef.current.push({
        x: Math.round(point.x),
        y: Math.round(point.y)
      });
      if (tool) {
        const nextPoint = { x: Math.round(point.x), y: Math.round(point.y) };
        setRetouchPreview((current) => {
          if (!current || current.mode !== tool) {
            return {
              mode: tool,
              points: [nextPoint],
              radiusPx: inpaintingBrushRadius,
              color: tool === "mask" ? "#ff9f1c" : inpaintingPaintColor
            };
          }
          return {
            ...current,
            radiusPx: inpaintingBrushRadius,
            color: tool === "mask" ? "#ff9f1c" : inpaintingPaintColor,
            points: [...current.points, nextPoint].slice(-1200)
          };
        });
      }
    },
    [inpaintingBrushRadius, inpaintingPaintColor]
  );

  const saveChapterWithInpaintPath = useCallback(
    async (pageId: string, inpaintedImagePath?: string, retainedInpaintedArtifactPaths: string[] = []) => {
      const chapter = currentChapterRef.current;
      if (!chapter) {
        return null;
      }
      const previousChapter = chapter;
      const nextChapter: ChapterSnapshot = {
        ...chapter,
        pages: chapter.pages.map((page) =>
          page.id === pageId
            ? {
                ...page,
                inpaintedImagePath,
                updatedAt: new Date().toISOString()
              }
            : page
        )
      };
      clearPageImageCache();
      setCurrentChapter(nextChapter);
      currentChapterRef.current = nextChapter;
      try {
        const result = await window.mangaApi.setPageInpaintingResult({
          chapterId: chapter.id,
          pageId,
          inpaintedImagePath: inpaintedImagePath ?? null,
          retainedInpaintedArtifactPaths
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
    [clearPageImageCache, currentChapterRef, mergeLiveChapter, setCurrentChapter]
  );

  const applyRetouchPoints = useCallback(
    async (tool: RetouchApplyTool, points: Array<{ x: number; y: number }>) => {
      if (!currentChapter || !selectedPage || points.length === 0 || jobActive || retouchBusyRef.current) {
        return;
      }
      retouchBusyRef.current = true;
      setRetouchBusy(true);
      const beforePath = selectedPage.inpaintedImagePath;
      const retainedInpaintedArtifactPaths = collectRetainedRetouchArtifactPaths(
        retouchUndoStackRef.current,
        retouchRedoStackRef.current,
        [beforePath]
      );
      try {
        const result = await window.mangaApi.applyInpaintingRetouch({
          chapterId: currentChapter.id,
          pageId: selectedPage.id,
          mode: tool === "brush" ? "paint" : "restore",
          points,
          radiusPx: inpaintingBrushRadius,
          color: inpaintingPaintColor,
          retainedInpaintedArtifactPaths
        });
        const afterPage = result.chapter.pages.find((page) => page.id === selectedPage.id);
        clearPageImageCache();
        mergeLiveChapter(result.chapter);
        const afterPath = afterPage?.inpaintedImagePath;
        if (afterPath !== beforePath) {
          setRetouchUndoStack((stack) => [...stack, { pageId: selectedPage.id, beforePath, afterPath }].slice(-60));
          setRetouchRedoStack([]);
        }
      } catch (error) {
        console.error(error);
        pushStatus("리터치 적용에 실패했습니다.");
      } finally {
        retouchBusyRef.current = false;
        setRetouchBusy(false);
      }
    },
    [clearPageImageCache, currentChapter, inpaintingBrushRadius, inpaintingPaintColor, jobActive, mergeLiveChapter, pushStatus, selectedPage]
  );

  const undoRetouch = useCallback(async () => {
    const entry = retouchUndoStackRef.current[retouchUndoStackRef.current.length - 1];
    if (!entry || jobActive || retouchBusyRef.current) {
      return;
    }
    retouchBusyRef.current = true;
    setRetouchBusy(true);
    setRetouchUndoStack((stack) => stack.slice(0, -1));
    const retainedInpaintedArtifactPaths = collectRetainedRetouchArtifactPaths(
      retouchUndoStackRef.current,
      retouchRedoStackRef.current,
      [entry.beforePath, entry.afterPath]
    );
    try {
      await saveChapterWithInpaintPath(entry.pageId, entry.beforePath, retainedInpaintedArtifactPaths);
      setRetouchRedoStack((stack) => [...stack, entry].slice(-60));
      pushStatus("리터치를 되돌렸습니다.");
    } catch (error) {
      console.error(error);
      setRetouchUndoStack((stack) => [...stack, entry].slice(-60));
      pushStatus("리터치 되돌리기에 실패했습니다.");
    } finally {
      retouchBusyRef.current = false;
      setRetouchBusy(false);
    }
  }, [jobActive, pushStatus, saveChapterWithInpaintPath]);

  const redoRetouch = useCallback(async () => {
    const entry = retouchRedoStackRef.current[retouchRedoStackRef.current.length - 1];
    if (!entry || jobActive || retouchBusyRef.current) {
      return;
    }
    retouchBusyRef.current = true;
    setRetouchBusy(true);
    setRetouchRedoStack((stack) => stack.slice(0, -1));
    const retainedInpaintedArtifactPaths = collectRetainedRetouchArtifactPaths(
      retouchUndoStackRef.current,
      retouchRedoStackRef.current,
      [entry.beforePath, entry.afterPath]
    );
    try {
      await saveChapterWithInpaintPath(entry.pageId, entry.afterPath, retainedInpaintedArtifactPaths);
      setRetouchUndoStack((stack) => [...stack, entry].slice(-60));
      pushStatus("리터치를 다시 적용했습니다.");
    } catch (error) {
      console.error(error);
      setRetouchRedoStack((stack) => [...stack, entry].slice(-60));
      pushStatus("리터치 다시 적용에 실패했습니다.");
    } finally {
      retouchBusyRef.current = false;
      setRetouchBusy(false);
    }
  }, [jobActive, pushStatus, saveChapterWithInpaintPath]);

  const clearRetouchHistory = useCallback(() => {
    clearRetouchStacks();
  }, []);

  function clearRetouchStacks(): void {
    retouchUndoStackRef.current = [];
    retouchRedoStackRef.current = [];
    setRetouchUndoStack([]);
    setRetouchRedoStack([]);
  }

  return {
    appendRetouchPoint,
    applyRetouchPoints,
    clearRetouchHistory,
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    redoRetouch,
    retouchBusy,
    retouchCursorPoint,
    retouchPreview,
    retouchRedoStack,
    retouchUndoStack,
    setRetouchCursorPoint,
    setRetouchPreview,
    undoRetouch
  };
}
