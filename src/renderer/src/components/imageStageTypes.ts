import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { DragHud } from "../hooks/useWorkspacePointerHandlers";
import type { ViewportSize } from "../lib/overlayLayout";

export type ImageStageProps = {
  page: MangaPage;
  imageDataUrl: string;
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageSize: ViewportSize | null;
  selectedBlockId: string | null;
  showTextBlocks: boolean;
  showBlockChrome: boolean;
  inpaintingMode?: boolean;
  blockPointerDisabled?: boolean;
  retouchCursor?: {
    point: { x: number; y: number } | null;
    radiusPx: number;
    mode: "brush" | "eraser" | "mask";
    color: string;
  } | null;
  retouchPreview?: {
    mode: "brush" | "eraser" | "mask";
    points: Array<{ x: number; y: number }>;
    radiusPx: number;
    color: string;
    originalImageDataUrl: string;
  } | null;
  maskStrokes?: InpaintingMaskStroke[];
  regionSelectionActive: boolean;
  regionSelectionRect: BBox | null;
  dragHud?: DragHud | null;
  onStagePointerMove: (event: React.PointerEvent) => void;
  onStagePointerUp: (event: React.PointerEvent) => void;
  onStagePointerDown: (event: React.PointerEvent) => void;
  onStagePointerLeave?: (event: React.PointerEvent) => void;
  onBlockPointerDown: (
    event: React.PointerEvent,
    block: TranslationBlock,
    mode: "move" | "resize",
  ) => void;
  onToggleBlockExcluded?: (blockId: string) => void;
};

export type RetouchStageModel = {
  cursorRadius: number;
  cursorScaleX: number;
  cursorScaleY: number;
  cursorVisible: boolean;
  maskStrokePaths: Array<{ path: string; width: number }>;
  previewPath: string;
  previewStrokeWidth: number;
};
