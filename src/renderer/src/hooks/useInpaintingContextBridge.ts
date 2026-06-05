import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot, InpaintingMaskStroke, JobState, MangaPage } from "../../../shared/types";
import type { BlockCounts, InpaintingContextValue } from "../inpainting/InpaintingContext";
import type { InpaintingTool } from "../components/InpaintingControlPanel";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { RetouchPreviewState } from "./useInpaintingRetouch";

type UseInpaintingContextBridgeOptions = {
  blockCounts: BlockCounts;
  brushColor: string;
  brushRadius: number;
  canRedo: boolean;
  canUndo: boolean;
  currentChapter: ChapterSnapshot | null;
  exportInpaintingResults: (scope: "page" | "chapter") => Promise<void>;
  inpaintedPageCount: number;
  jobActive: boolean;
  jobState: JobState;
  maskStrokes: InpaintingMaskStroke[];
  onCancelJob: () => void;
  onClearPatternMask: () => void;
  onShowGuide: () => void;
  peekAvailable: boolean;
  peeking: boolean;
  progressSnapshot: ProgressSnapshot | null;
  redoRetouch: () => Promise<void>;
  retouchBusy: boolean;
  retouchCursorPoint: { x: number; y: number } | null;
  retouchPreview: RetouchPreviewState | null;
  revertInpainting: (scope: "page" | "chapter") => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: "page" | "chapter") => Promise<void>;
  selectedPage: MangaPage | null;
  selectedPageOriginalImageDataUrl: string;
  setBrushColor: Dispatch<SetStateAction<string>>;
  setBrushRadius: Dispatch<SetStateAction<number>>;
  setPeeking: Dispatch<SetStateAction<boolean>>;
  setShowBlockChrome: Dispatch<SetStateAction<boolean>>;
  setShowTextBlocks: Dispatch<SetStateAction<boolean>>;
  setTool: Dispatch<SetStateAction<InpaintingTool>>;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  tool: InpaintingTool;
  undoRetouch: () => Promise<void>;
};

export function useInpaintingContextBridge({
  blockCounts,
  brushColor,
  brushRadius,
  canRedo,
  canUndo,
  currentChapter,
  exportInpaintingResults,
  inpaintedPageCount,
  jobActive,
  jobState,
  maskStrokes,
  onCancelJob,
  onClearPatternMask,
  onShowGuide,
  peekAvailable,
  peeking,
  progressSnapshot,
  redoRetouch,
  retouchBusy,
  retouchCursorPoint,
  retouchPreview,
  revertInpainting,
  runDrawnPatternInpainting,
  runInpainting,
  selectedPage,
  selectedPageOriginalImageDataUrl,
  setBrushColor,
  setBrushRadius,
  setPeeking,
  setShowBlockChrome,
  setShowTextBlocks,
  setTool,
  showBlockChrome,
  showTextBlocks,
  tool,
  undoRetouch
}: UseInpaintingContextBridgeOptions): {
  contextValue: InpaintingContextValue;
  retouchCursor: {
    color: string;
    mode: "brush" | "eraser" | "mask";
    point: { x: number; y: number } | null;
    radiusPx: number;
  } | null;
  retouchPreviewLayer: (RetouchPreviewState & { originalImageDataUrl: string }) | null;
} {
  const retouchCursor =
    tool === "brush" || tool === "eraser" || tool === "mask"
      ? {
          point: retouchCursorPoint,
          radiusPx: brushRadius,
          mode: tool,
          color: tool === "brush" ? brushColor : tool === "mask" ? "#ff9f1c" : "#70b7ff"
        }
      : null;

  const retouchPreviewLayer =
    retouchPreview && retouchPreview.points.length > 0
      ? {
          ...retouchPreview,
          originalImageDataUrl: retouchPreview.mode === "eraser" ? selectedPageOriginalImageDataUrl : ""
        }
      : null;

  const contextValue = useMemo<InpaintingContextValue>(
    () => ({
      currentChapter,
      selectedPage,
      blockCounts,
      inpaintedPageCount,
      tool,
      brushRadius,
      brushColor,
      maskStrokeCount: maskStrokes.length,
      canUndo: !retouchBusy && canUndo,
      canRedo: !retouchBusy && canRedo,
      jobState,
      progressSnapshot,
      showBlockChrome,
      showTextBlocks,
      jobActive,
      peekAvailable,
      peeking,
      onSelectTool: setTool,
      onBrushRadiusChange: setBrushRadius,
      onBrushColorChange: setBrushColor,
      onUndoRetouch: () => void undoRetouch(),
      onRedoRetouch: () => void redoRetouch(),
      onRevertPage: () => void revertInpainting("page"),
      onRevertChapter: () => void revertInpainting("chapter"),
      onRunPage: () => void runInpainting("page"),
      onRunChapter: () => void runInpainting("chapter"),
      onRunDrawnPattern: () => void runDrawnPatternInpainting(),
      onClearPatternMask,
      onShowGuide,
      onPeekToggle: () => setPeeking((value) => !value),
      onToggleChrome: () => setShowBlockChrome((value) => !value),
      onToggleBlocks: () => setShowTextBlocks((value) => !value),
      onExportResults: (scope) => void exportInpaintingResults(scope),
      onCancelJob
    }),
    [
      blockCounts,
      brushColor,
      brushRadius,
      canRedo,
      canUndo,
      currentChapter,
      exportInpaintingResults,
      inpaintedPageCount,
      jobActive,
      jobState,
      maskStrokes.length,
      onCancelJob,
      onClearPatternMask,
      onShowGuide,
      peekAvailable,
      peeking,
      progressSnapshot,
      redoRetouch,
      retouchBusy,
      revertInpainting,
      runDrawnPatternInpainting,
      runInpainting,
      selectedPage,
      setBrushColor,
      setBrushRadius,
      setPeeking,
      setShowBlockChrome,
      setShowTextBlocks,
      setTool,
      showBlockChrome,
      showTextBlocks,
      tool,
      undoRetouch
    ]
  );

  return { contextValue, retouchCursor, retouchPreviewLayer };
}
