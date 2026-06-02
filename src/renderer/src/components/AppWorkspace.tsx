import React from "react";
import type { JobState, MangaPage } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { ImageStage, type ImageStageProps } from "./ImageStage";
import { InstallProgressOverlay } from "./InstallProgressOverlay";
import { Button } from "./ui";
import { useFonts } from "../fonts/FontsContext";

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
  inpaintingMode: boolean;
  showingOriginalPeek: boolean;
  inpaintingToolActive: boolean;
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
  onToggleBlockExcluded: ImageStageProps["onToggleBlockExcluded"];
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
  inpaintingMode,
  showingOriginalPeek,
  inpaintingToolActive,
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
  onToggleBlockExcluded,
  onOpenTranslationSource,
  onOpenBatchImport,
  onOpenShareImport
}: AppWorkspaceProps): React.JSX.Element {
  // Subscribe to custom-font changes so overlay text re-resolves families when fonts load/register.
  useFonts();
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
          {showingOriginalPeek ? <div className="peek-original-badge">원본</div> : null}
          <ImageStage
            page={selectedPage}
            imageDataUrl={selectedPageImageDataUrl}
            imageRef={imageRef}
            stageRef={stageRef}
            stageSize={stageSize}
            selectedBlockId={selectedBlockId}
            showTextBlocks={showTextBlocks}
            showBlockChrome={showBlockChrome && !inpaintingToolActive}
            inpaintingMode={inpaintingMode}
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
            onToggleBlockExcluded={onToggleBlockExcluded}
          />
        </div>
      ) : (
        <div className="empty-state">
          <h2>보관함에서 화를 열거나 새로 가져오세요.</h2>
          <p>작품과 화 단위로 저장해두고, 이어서 번역하거나 페이지별로 다시 번역할 수 있습니다.</p>
          <div className="empty-actions">
            <Button variant="primary" onClick={onOpenTranslationSource}>
              번역
            </Button>
            <Button onClick={onOpenBatchImport}>작품 일괄 번역</Button>
            <Button onClick={onOpenShareImport}>가져오기</Button>
          </div>
        </div>
      )}
      <InstallProgressOverlay job={jobState} snapshot={progressSnapshot} />
    </section>
  );
}
