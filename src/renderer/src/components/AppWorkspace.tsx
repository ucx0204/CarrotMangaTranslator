import React from "react";
import type { JobState } from "../../../shared/jobTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { ImageStage, type ImageStageProps } from "./ImageStage";
import { InstallProgressOverlay } from "./InstallProgressOverlay";
import { Button } from "./ui";
import { useFonts } from "../fonts/useFonts";

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
  dragHud: ImageStageProps["dragHud"];
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onStagePointerMove: ImageStageProps["onStagePointerMove"];
  onStagePointerUp: ImageStageProps["onStagePointerUp"];
  onStagePointerDown: ImageStageProps["onStagePointerDown"];
  onStagePointerLeave: ImageStageProps["onStagePointerLeave"];
  onBlockPointerDown: ImageStageProps["onBlockPointerDown"];
  onToggleBlockExcluded: ImageStageProps["onToggleBlockExcluded"];
  onOpenTranslationSource: () => void;
  onOpenBatchImport: () => void;
  onOpenShareImport: () => void;
  onOpenSettings: () => void;
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
  dragHud,
  jobState,
  progressSnapshot,
  onStagePointerMove,
  onStagePointerUp,
  onStagePointerDown,
  onStagePointerLeave,
  onBlockPointerDown,
  onToggleBlockExcluded,
  onOpenTranslationSource,
  onOpenBatchImport,
  onOpenShareImport,
  onOpenSettings,
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
    >
      {selectedPage ? (
        <WorkspacePane
          blockPointerDisabled={inpaintingToolActive}
          dragHud={dragHud}
          imageDataUrl={selectedPageImageDataUrl}
          imageRef={imageRef}
          inpaintingMode={inpaintingMode}
          maskStrokes={maskStrokes}
          onBlockPointerDown={onBlockPointerDown}
          onStagePointerDown={onStagePointerDown}
          onStagePointerLeave={onStagePointerLeave}
          onStagePointerMove={onStagePointerMove}
          onStagePointerUp={onStagePointerUp}
          onToggleBlockExcluded={onToggleBlockExcluded}
          page={selectedPage}
          regionSelectionActive={regionSelectionActive}
          regionSelectionRect={regionSelectionRect}
          retouchCursor={retouchCursor}
          retouchPreview={retouchPreviewLayer}
          selectedBlockId={selectedBlockId}
          showBlockChrome={showBlockChrome && !inpaintingToolActive}
          showingOriginalPeek={showingOriginalPeek}
          showTextBlocks={showTextBlocks}
          stageRef={stageRef}
          stageSize={stageSize}
        />
      ) : (
        <EmptyWorkspace
          onOpenBatchImport={onOpenBatchImport}
          onOpenSettings={onOpenSettings}
          onOpenShareImport={onOpenShareImport}
          onOpenTranslationSource={onOpenTranslationSource}
        />
      )}
      <InstallProgressOverlay job={jobState} snapshot={progressSnapshot} />
    </section>
  );
}

function WorkspacePane({
  showingOriginalPeek,
  ...stageProps
}: ImageStageProps & {
  showingOriginalPeek: boolean;
}): React.JSX.Element {
  return (
    <div className="workspace-pane">
      {showingOriginalPeek ? (
        <div className="peek-original-badge">원본</div>
      ) : null}
      <ImageStage {...stageProps} />
    </div>
  );
}

function EmptyWorkspace({
  onOpenBatchImport,
  onOpenSettings,
  onOpenShareImport,
  onOpenTranslationSource,
}: Pick<
  AppWorkspaceProps,
  | "onOpenBatchImport"
  | "onOpenSettings"
  | "onOpenShareImport"
  | "onOpenTranslationSource"
>): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-card">
        <h2>망가 번역을 시작해요</h2>
        <p>
          이미지·폴더·ZIP을 가져와 작품과 화 단위로 저장하고, 페이지별로
          번역·인페인팅·편집할 수 있어요.
        </p>
        <EmptyWorkspaceSteps
          onOpenSettings={onOpenSettings}
          onOpenTranslationSource={onOpenTranslationSource}
        />
        <div className="empty-actions">
          <Button variant="primary" onClick={onOpenTranslationSource}>
            번역 시작
          </Button>
          <Button onClick={onOpenBatchImport}>작품 일괄 번역</Button>
          <Button onClick={onOpenShareImport}>공유본 가져오기</Button>
        </div>
        <p className="empty-hints">
          <kbd>←</kbd> <kbd>→</kbd> 페이지 이동 · <kbd>Ctrl</kbd>+<kbd>K</kbd>{" "}
          명령 팔레트 · <kbd>?</kbd> 단축키
        </p>
      </div>
    </div>
  );
}

function EmptyWorkspaceSteps({
  onOpenSettings,
  onOpenTranslationSource,
}: Pick<
  AppWorkspaceProps,
  "onOpenSettings" | "onOpenTranslationSource"
>): React.JSX.Element {
  return (
    <ol className="empty-steps">
      <li>
        <span className="empty-step-num">1</span>
        <div className="empty-step-body">
          <strong>번역 엔진 설정</strong>
          <span>모델·OCR·하드웨어를 먼저 확인하세요.</span>
        </div>
        <Button size="sm" onClick={onOpenSettings}>
          설정 열기
        </Button>
      </li>
      <li>
        <span className="empty-step-num">2</span>
        <div className="empty-step-body">
          <strong>원본 가져오기</strong>
          <span>이미지·폴더·ZIP에서 페이지를 불러옵니다.</span>
        </div>
        <Button size="sm" onClick={onOpenTranslationSource}>
          가져오기
        </Button>
      </li>
      <li>
        <span className="empty-step-num">3</span>
        <div className="empty-step-body">
          <strong>번역 &amp; 편집</strong>
          <span>이어서 번역하고 블록을 다듬으세요.</span>
        </div>
      </li>
    </ol>
  );
}
