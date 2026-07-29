import type { JobState } from "../../../shared/jobTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import type { RetouchTool, WorkspaceTool } from "../lib/stageTool";
import type { WorkspaceFitMode } from "../lib/workspaceZoom";
import type { WorkspaceInteractionPreviewStore } from "../lib/workspaceInteractionPreview";
import type { ImageStageProps } from "./ImageStage";

export type AppWorkspaceProps = {
  workspacePanelRef: React.RefObject<HTMLElement | null>;
  workspaceFitMode: WorkspaceFitMode;
  workspaceZoom: number;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  selectedPageImageLoading?: boolean;
  selectedPageImagePageId: string | null;
  imageRef: ImageStageProps["imageRef"];
  stageRef: ImageStageProps["stageRef"];
  stageSize: ImageStageProps["stageSize"];
  interactionPreviewStore: WorkspaceInteractionPreviewStore;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  showTextBlocks: boolean;
  showBlockChrome: boolean;
  showingOriginalPeek: boolean;
  brushColor: string;
  brushRadius: number;
  retouchCursor: ImageStageProps["retouchCursor"];
  retouchOriginalImageDataUrl: string;
  maskStrokes: ImageStageProps["maskStrokes"];
  regionSelectionActive: boolean;
  regionTranslationAvailable: boolean;
  regionSelectionRect: ImageStageProps["regionSelectionRect"];
  lastRetouchTool: RetouchTool;
  stageTool: WorkspaceTool;
  stageToolbarHidden: boolean;
  jobActive: boolean;
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onSelectStageTool: (tool: WorkspaceTool) => void;
  onToggleRegionTranslation: () => void;
  onToggleStageToolbarHidden: () => void;
  onChangeWorkspaceFitMode: (fitMode: WorkspaceFitMode) => void;
  onResetWorkspaceZoom: () => void;
  onZoomInWorkspace: () => void;
  onZoomOutWorkspace: () => void;
  onStagePointerMove: ImageStageProps["onStagePointerMove"];
  onStagePointerUp: ImageStageProps["onStagePointerUp"];
  onStagePointerDown: ImageStageProps["onStagePointerDown"];
  onStagePointerLeave: ImageStageProps["onStagePointerLeave"];
  onApplyBubbleLayoutDraft: NonNullable<
    ImageStageProps["onApplyBubbleLayoutDraft"]
  >;
  onCancelBubbleLayoutDraft: NonNullable<
    ImageStageProps["onCancelBubbleLayoutDraft"]
  >;
  onUndoBubbleLayoutPoint: NonNullable<
    ImageStageProps["onUndoBubbleLayoutPoint"]
  >;
  onBlockPointerDown: ImageStageProps["onBlockPointerDown"];
  onOpenTranslationSource: () => void;
  onOpenBatchImport: () => void;
  onOpenShareImport: () => void;
  onOpenSettings: () => void;
};
