import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";

export type RetouchPoint = { x: number; y: number };

export type RetouchPreviewState = {
  mode: "brush" | "eraser" | "mask";
  points: RetouchPoint[];
  radiusPx: number;
  color: string;
};

export type RetouchHistoryEntry = {
  pageId: string;
  beforePath?: string;
  afterPath?: string;
};

export type RetouchDrawTool = "brush" | "eraser" | "mask";
export type RetouchApplyTool = "brush" | "eraser";

export type UseInpaintingRetouchOptions = {
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

export type InpaintingRetouchResult = {
  appendRetouchPoint: (point: RetouchPoint, tool?: RetouchDrawTool) => void;
  applyRetouchPoints: (
    tool: RetouchApplyTool,
    points: RetouchPoint[],
  ) => Promise<void>;
  clearRetouchHistory: () => void;
  inpaintingRetouchDrawingRef: MutableRefObject<boolean>;
  inpaintingRetouchPointsRef: MutableRefObject<RetouchPoint[]>;
  lastInpaintingRetouchPointRef: MutableRefObject<RetouchPoint | null>;
  redoRetouch: () => Promise<void>;
  retouchBusy: boolean;
  retouchCursorPoint: RetouchPoint | null;
  retouchPreview: RetouchPreviewState | null;
  retouchRedoStack: RetouchHistoryEntry[];
  retouchUndoStack: RetouchHistoryEntry[];
  setRetouchCursorPoint: Dispatch<SetStateAction<RetouchPoint | null>>;
  setRetouchPreview: Dispatch<SetStateAction<RetouchPreviewState | null>>;
  undoRetouch: () => Promise<void>;
};

export type RetouchStackSetter = Dispatch<
  SetStateAction<RetouchHistoryEntry[]>
>;
