import type { BBox, TranslationBlock } from "../../../shared/textTypes";
import type { InpaintingMaskStroke } from "../../../shared/inpaintingTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { DragMode } from "../lib/workspaceInteractionTypes";
import type { ViewportSize } from "../lib/overlayLayout";
import type { StageTool } from "../lib/stageTool";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";

export type ImageStageProps = {
  page: MangaPage;
  imageDataUrl: string;
  imageLoading?: boolean;
  imageRef: React.RefObject<HTMLImageElement | null>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  stageSize: ViewportSize | null;
  textLayoutStageSize: ViewportSize | null;
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  selectedBlockId: string | null;
  selectedBlockIds?: string[];
  showTextBlocks: boolean;
  showBlockChrome: boolean;
  hideEditingOverlays?: boolean;
  blockPointerDisabled?: boolean;
  retouchCursor?: {
    radiusPx: number;
    mode: "brush" | "rectangle" | "ellipse" | "eraser" | "mask";
    color: string;
  } | null;
  retouchOriginalImageDataUrl?: string;
  maskStrokes?: InpaintingMaskStroke[];
  regionSelectionActive: boolean;
  regionSelectionRect: BBox | null;
  stageTool?: StageTool;
  onStagePointerMove: (event: React.PointerEvent) => void;
  onStagePointerUp: (event: React.PointerEvent) => void;
  onStagePointerDown: (event: React.PointerEvent) => void;
  onStagePointerLeave?: (event: React.PointerEvent) => void;
  onApplyBubbleLayoutDraft?: () => void;
  onCancelBubbleLayoutDraft?: () => void;
  onUndoBubbleLayoutPoint?: () => void;
  onBlockPointerDown: (
    event: React.PointerEvent,
    block: TranslationBlock,
    mode: DragMode,
  ) => void;
};

export type RetouchStageModel = {
  maskStrokePaths: Array<{ path: string; width: number }>;
};
