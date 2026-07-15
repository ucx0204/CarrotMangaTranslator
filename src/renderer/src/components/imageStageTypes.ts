import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { DragHud } from "../hooks/useWorkspacePointerHandlers";
import type { DragMode } from "../hooks/workspacePointerGeometry";
import type { ViewportSize } from "../lib/overlayLayout";
import type { StageTool } from "../lib/stageTool";

export type ImageStageProps = {
  page: MangaPage;
  imageDataUrl: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageSize: ViewportSize | null;
  textLayoutStageSize: ViewportSize | null;
  selectedBlockId: string | null;
  selectedBlockIds?: string[];
  showTextBlocks: boolean;
  showBlockChrome: boolean;
  blockPointerDisabled?: boolean;
  retouchCursor?: {
    radiusPx: number;
    mode: "brush" | "eraser" | "mask";
    color: string;
  } | null;
  retouchOriginalImageDataUrl?: string;
  maskStrokes?: InpaintingMaskStroke[];
  regionSelectionActive: boolean;
  regionSelectionRect: BBox | null;
  blockCreateRect?: BBox | null;
  stageTool?: StageTool;
  dragHud?: DragHud | null;
  onStagePointerMove: (event: React.PointerEvent) => void;
  onStagePointerUp: (event: React.PointerEvent) => void;
  onStagePointerDown: (event: React.PointerEvent) => void;
  onStagePointerLeave?: (event: React.PointerEvent) => void;
  onBlockPointerDown: (
    event: React.PointerEvent,
    block: TranslationBlock,
    mode: DragMode,
  ) => void;
};

export type RetouchStageModel = {
  maskStrokePaths: Array<{ path: string; width: number }>;
};
