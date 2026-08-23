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

type UseInpaintingContextBridgeOptions = {
  blockCounts: BlockCounts;
  brushColor: string;
  brushRadius: number;
  canRedo: boolean;
  canUndo: boolean;
  currentChapter: ChapterSnapshot | null;
  inpaintedPageCount: number;
  jobActive: boolean;
  jobState: JobState;
  maskStrokes: InpaintingMaskStroke[];
  onCancelJob: () => void;
  onClearPatternMask: () => void;
  onAdjustPatternMask: (deltaPx: number) => void;
  onShowGuide: () => void;
  peekAvailable: boolean;
  peeking: boolean;
  progressSnapshot: ProgressSnapshot | null;
  redoRetouch: () => Promise<void>;
  retouchBusy: boolean;
  revertInpainting: (scope: "page" | "chapter") => Promise<void>;
  runDrawnPatternInpainting: () => Promise<void>;
  runInpainting: (scope: "page" | "chapter") => Promise<void>;
  selectedPage: MangaPage | null;
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

type RetouchCursorMode =
  | "brush"
  | "rectangle"
  | "ellipse"
  | "eraser"
  | "eraser-rectangle"
  | "mask";

type RetouchCursor = {
  color: string;
  mode: RetouchCursorMode;
  radiusPx: number;
} | null;

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
  | "retouchBusy"
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
};

const RETOUCH_CURSOR_COLORS: Record<
  Extract<RetouchCursorMode, "eraser" | "eraser-rectangle" | "mask">,
  string
> = {
  eraser: "#70b7ff",
  "eraser-rectangle": "#70b7ff",
  mask: "#ff9f1c",
};

function isRetouchCursorMode(tool: InpaintingTool): tool is RetouchCursorMode {
  return (
    tool === "brush" ||
    tool === "rectangle" ||
    tool === "ellipse" ||
    tool === "eraser" ||
    tool === "eraser-rectangle" ||
    tool === "mask"
  );
}

function resolveRetouchCursor({
  brushColor,
  brushRadius,
  tool,
}: Pick<
  UseInpaintingContextBridgeOptions,
  "brushColor" | "brushRadius" | "tool"
>): RetouchCursor {
  if (!isRetouchCursorMode(tool)) {
    return null;
  }
  return {
    radiusPx:
      tool === "rectangle" || tool === "ellipse" || tool === "eraser-rectangle"
        ? 0
        : brushRadius,
    mode: tool,
    color:
      tool === "brush" || tool === "rectangle" || tool === "ellipse"
        ? brushColor
        : RETOUCH_CURSOR_COLORS[tool],
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
      jobActive: jobActive || retouchBusy,
      retouchBusy,
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
  onCancelJob,
  onClearPatternMask,
  onAdjustPatternMask,
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
      onAdjustPatternMask,
      onShowGuide,
      onPeekToggle: () => setPeeking((value) => !value),
      onToggleChrome: () => setShowBlockChrome((value) => !value),
      onToggleBlocks: () => setShowTextBlocks((value) => !value),
      onCancelJob,
    }),
    [
      onCancelJob,
      onClearPatternMask,
      onAdjustPatternMask,
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
  const { brushColor, brushRadius, peeking, tool } = options;
  const retouchCursor = useMemo(
    () =>
      peeking ? null : resolveRetouchCursor({ brushColor, brushRadius, tool }),
    [brushColor, brushRadius, peeking, tool],
  );
  const contextValue = useInpaintingContextValue(options);

  return { contextValue, retouchCursor };
}
