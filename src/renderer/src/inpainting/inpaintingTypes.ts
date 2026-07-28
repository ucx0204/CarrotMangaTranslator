import type { ChapterSnapshot, MangaPage } from "../../../shared/libraryTypes";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";

export type InpaintingTool =
  | "none"
  | "brush"
  | "rectangle"
  | "ellipse"
  | "eraser"
  | "picker"
  | "mask";

export type BlockCounts = {
  total: number;
  selectedPage: number;
  pendingTotal: number;
  pendingPages: number;
};

export type InpaintingContextValue = {
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  blockCounts: BlockCounts;
  inpaintedPageCount: number;
  tool: InpaintingTool;
  brushRadius: number;
  brushColor: string;
  maskStrokeCount: number;
  canUndo: boolean;
  canRedo: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  jobActive: boolean;
  retouchBusy: boolean;
  peekAvailable: boolean;
  peeking: boolean;
  onSelectTool: (tool: InpaintingTool) => void;
  onBrushRadiusChange: (radius: number) => void;
  onBrushColorChange: (color: string) => void;
  onUndoRetouch: () => void;
  onRedoRetouch: () => void;
  onRevertPage: () => void;
  onRevertChapter: () => void;
  onRunPage: () => void;
  onRunChapter: () => void;
  onRunDrawnPattern: () => void;
  onClearPatternMask: () => void;
  onShowGuide: () => void;
  onPeekToggle: () => void;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
  onCancelJob: () => void;
};
