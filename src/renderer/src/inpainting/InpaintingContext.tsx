import React from "react";
import type { ChapterSnapshot, JobState, MangaPage } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";

export type InpaintingTool = "none" | "brush" | "eraser" | "picker" | "mask";

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
  onExportResults: (scope: "page" | "chapter") => void;
  onCancelJob: () => void;
};

const InpaintingContext = React.createContext<InpaintingContextValue | null>(null);

export function InpaintingProvider({
  value,
  children
}: {
  value: InpaintingContextValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return <InpaintingContext.Provider value={value}>{children}</InpaintingContext.Provider>;
}

export function useInpainting(): InpaintingContextValue {
  const context = React.useContext(InpaintingContext);
  if (!context) {
    throw new Error("useInpainting must be used within an InpaintingProvider");
  }
  return context;
}
