import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";

export type RetouchPoint = { x: number; y: number };

export type RetouchHistoryEntry = {
  pageId: string;
  beforePath?: string;
  afterPath?: string;
};

export type RetouchApplyTool = "brush" | "eraser";

export type UseInpaintingRetouchOptions = {
  clearPageImageCache: () => void;
  currentChapter: ChapterSnapshot | null;
  currentChapterRef: MutableRefObject<ChapterSnapshot | null>;
  dirty: boolean;
  inpaintingBrushRadius: number;
  inpaintingPaintColor: string;
  jobActive: boolean;
  mergeLiveChapter: (chapter: ChapterSnapshot) => void;
  pushStatus: (line: string) => void;
  saveNow: () => Promise<void>;
  selectedPage: MangaPage | null;
  setCurrentChapter: Dispatch<SetStateAction<ChapterSnapshot | null>>;
};

export type InpaintingRetouchResult = {
  appendRetouchPoint: (point: RetouchPoint) => RetouchPoint | null;
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
  retouchRedoStack: RetouchHistoryEntry[];
  retouchUndoStack: RetouchHistoryEntry[];
  undoRetouch: () => Promise<void>;
};

export type RetouchStackSetter = Dispatch<
  SetStateAction<RetouchHistoryEntry[]>
>;
