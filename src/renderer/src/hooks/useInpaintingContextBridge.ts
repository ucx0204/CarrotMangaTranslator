import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { JobState } from "../../../shared/jobTypes";
import type {
  BlockCounts,
  InpaintingContextValue,
  InpaintingTool,
} from "../inpainting/inpaintingTypes";
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

type RetouchCursorMode = "brush" | "eraser" | "mask";

type RetouchCursor = {
  color: string;
  mode: RetouchCursorMode;
  point: { x: number; y: number } | null;
  radiusPx: number;
} | null;

type RetouchPreviewLayer =
  | (RetouchPreviewState & { originalImageDataUrl: string })
  | null;

type InpaintingContextState = Pick<
  InpaintingContextValue,
  | "blockCounts"
  | "brushColor"
  | "brushRadius"
  | "canRedo"
  | "canUndo"
  | "currentChapter"
  | "inpaintedPageCount"
  | "jobActive"
  | "jobState"
  | "maskStrokeCount"
  | "peekAvailable"
  | "peeking"
  | "progressSnapshot"
  | "selectedPage"
  | "showBlockChrome"
  | "showTextBlocks"
  | "tool"
>;

type InpaintingContextActions = Omit<
  InpaintingContextValue,
  keyof InpaintingContextState
>;

type InpaintingBridgeResult = {
  contextValue: InpaintingContextValue;
  retouchCursor: RetouchCursor;
  retouchPreviewLayer: RetouchPreviewLayer;
};

const RETOUCH_CURSOR_COLORS: Record<
  Exclude<RetouchCursorMode, "brush">,
  string
> = {
  eraser: "#70b7ff",
  mask: "#ff9f1c",
};

function isRetouchCursorMode(tool: InpaintingTool): tool is RetouchCursorMode {
  return tool === "brush" || tool === "eraser" || tool === "mask";
}

function resolveRetouchCursor({
  brushColor,
  brushRadius,
  retouchCursorPoint,
  tool,
}: Pick<
  UseInpaintingContextBridgeOptions,
  "brushColor" | "brushRadius" | "retouchCursorPoint" | "tool"
>): RetouchCursor {
  if (!isRetouchCursorMode(tool)) {
    return null;
  }
  return {
    point: retouchCursorPoint,
    radiusPx: brushRadius,
    mode: tool,
    color: tool === "brush" ? brushColor : RETOUCH_CURSOR_COLORS[tool],
  };
}

function resolveRetouchPreviewLayer(
  retouchPreview: RetouchPreviewState | null,
  selectedPageOriginalImageDataUrl: string,
): RetouchPreviewLayer {
  if (!retouchPreview || retouchPreview.points.length === 0) {
    return null;
  }
  return {
    ...retouchPreview,
    originalImageDataUrl:
      retouchPreview.mode === "eraser" ? selectedPageOriginalImageDataUrl : "",
  };
}

function useInpaintingContextState({
  blockCounts,
  brushColor,
  brushRadius,
  canRedo,
  canUndo,
  currentChapter,
  inpaintedPageCount,
  jobActive,
  jobState,
  maskStrokes,
  peekAvailable,
  peeking,
  progressSnapshot,
  retouchBusy,
  selectedPage,
  showBlockChrome,
  showTextBlocks,
  tool,
}: UseInpaintingContextBridgeOptions): InpaintingContextState {
  return useMemo<InpaintingContextState>(
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
    }),
    [
      blockCounts,
      brushColor,
      brushRadius,
      canRedo,
      canUndo,
      currentChapter,
      inpaintedPageCount,
      jobActive,
      jobState,
      maskStrokes.length,
      peekAvailable,
      peeking,
      progressSnapshot,
      retouchBusy,
      selectedPage,
      showBlockChrome,
      showTextBlocks,
      tool,
    ],
  );
}

function useInpaintingContextActions({
  exportInpaintingResults,
  onCancelJob,
  onClearPatternMask,
  onShowGuide,
  redoRetouch,
  revertInpainting,
  runDrawnPatternInpainting,
  runInpainting,
  setBrushColor,
  setBrushRadius,
  setPeeking,
  setShowBlockChrome,
  setShowTextBlocks,
  setTool,
  undoRetouch,
}: UseInpaintingContextBridgeOptions): InpaintingContextActions {
  return useMemo<InpaintingContextActions>(
    () => ({
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
      onCancelJob,
    }),
    [
      exportInpaintingResults,
      onCancelJob,
      onClearPatternMask,
      onShowGuide,
      redoRetouch,
      revertInpainting,
      runDrawnPatternInpainting,
      runInpainting,
      setBrushColor,
      setBrushRadius,
      setPeeking,
      setShowBlockChrome,
      setShowTextBlocks,
      setTool,
      undoRetouch,
    ],
  );
}

function useInpaintingContextValue(
  options: UseInpaintingContextBridgeOptions,
): InpaintingContextValue {
  const state = useInpaintingContextState(options);
  const actions = useInpaintingContextActions(options);

  return useMemo(
    () => ({
      ...state,
      ...actions,
    }),
    [actions, state],
  );
}

export function useInpaintingContextBridge(
  options: UseInpaintingContextBridgeOptions,
): InpaintingBridgeResult {
  const retouchCursor = resolveRetouchCursor(options);
  const retouchPreviewLayer = resolveRetouchPreviewLayer(
    options.retouchPreview,
    options.selectedPageOriginalImageDataUrl,
  );
  const contextValue = useInpaintingContextValue(options);

  return { contextValue, retouchCursor, retouchPreviewLayer };
}
