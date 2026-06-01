import React from "react";
import type { JobState, MangaPage } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { ImageStage, type ImageStageProps } from "./ImageStage";
import { InstallProgressOverlay } from "./InstallProgressOverlay";

type AppWorkspaceProps = {
  workspacePanelRef: React.RefObject<HTMLElement | null>;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  imageRef: ImageStageProps["imageRef"];
  stageRef: ImageStageProps["stageRef"];
  stageSize: ImageStageProps["stageSize"];
  selectedBlockId: string | null;
  showTextBlocks: boolean;
  showBlockChrome: boolean;
  inpaintingToolActive: boolean;
  inpaintingHighlightType: ImageStageProps["highlightBlockType"];
  retouchCursor: ImageStageProps["retouchCursor"];
  retouchPreviewLayer: ImageStageProps["retouchPreview"];
  maskStrokes: ImageStageProps["maskStrokes"];
  regionSelectionActive: boolean;
  regionSelectionRect: ImageStageProps["regionSelectionRect"];
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onWorkspaceWheel: React.WheelEventHandler<HTMLElement>;
  onStagePointerMove: ImageStageProps["onStagePointerMove"];
  onStagePointerUp: ImageStageProps["onStagePointerUp"];
  onStagePointerDown: ImageStageProps["onStagePointerDown"];
  onStagePointerLeave: ImageStageProps["onStagePointerLeave"];
  onBlockPointerDown: ImageStageProps["onBlockPointerDown"];
  onOpenTranslationSource: () => void;
  onOpenBatchImport: () => void;
  onOpenShareImport: () => void;
};

export function AppWorkspace({
  workspacePanelRef,
  selectedPage,
  selectedPageImageDataUrl,
  imageRef,
  stageRef,
  stageSize,
  selectedBlockId,
  showTextBlocks,
  showBlockChrome,
  inpaintingToolActive,
  inpaintingHighlightType,
  retouchCursor,
  retouchPreviewLayer,
  maskStrokes,
  regionSelectionActive,
  regionSelectionRect,
  jobState,
  progressSnapshot,
  onWorkspaceWheel,
  onStagePointerMove,
  onStagePointerUp,
  onStagePointerDown,
  onStagePointerLeave,
  onBlockPointerDown,
  onOpenTranslationSource,
  onOpenBatchImport,
  onOpenShareImport
}: AppWorkspaceProps): React.JSX.Element {
  return (
    <section
      ref={workspacePanelRef}
      className="workspace"
      tabIndex={0}
      aria-label="읽기 영역"
      onMouseDown={() => workspacePanelRef.current?.focus()}
      onWheel={onWorkspaceWheel}
    >
      {selectedPage ? (
        <div className="workspace-pane">
          <ImageStage
            page={selectedPage}
            imageDataUrl={selectedPageImageDataUrl}
            imageRef={imageRef}
            stageRef={stageRef}
            stageSize={stageSize}
            selectedBlockId={selectedBlockId}
            showTextBlocks={showTextBlocks}
            showBlockChrome={showBlockChrome && !inpaintingToolActive}
            highlightBlockType={inpaintingHighlightType}
            blockPointerDisabled={inpaintingToolActive}
            retouchCursor={retouchCursor}
            retouchPreview={retouchPreviewLayer}
            maskStrokes={maskStrokes}
            regionSelectionActive={regionSelectionActive}
            regionSelectionRect={regionSelectionRect}
            onStagePointerMove={onStagePointerMove}
            onStagePointerUp={onStagePointerUp}
            onStagePointerDown={onStagePointerDown}
            onStagePointerLeave={onStagePointerLeave}
            onBlockPointerDown={onBlockPointerDown}
          />
        </div>
      ) : (
        <div className="empty-state">
          <h2>보관함에서 화를 열거나 새로 가져오세요.</h2>
          <p>작품과 화 단위로 저장해두고, 이어서 번역하거나 페이지별로 다시 번역할 수 있습니다.</p>
          <div className="empty-actions">
            <button className="primary" onClick={onOpenTranslationSource}>
              번역
            </button>
            <button onClick={onOpenBatchImport}>작품 일괄 번역</button>
            <button className="import-button" onClick={onOpenShareImport}>
              가져오기
            </button>
          </div>
        </div>
      )}
      <InstallProgressOverlay job={jobState} snapshot={progressSnapshot} />
    </section>
  );
}
