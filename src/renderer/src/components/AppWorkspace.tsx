import React from "react";
import type { JobState } from "../../../shared/jobTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { ImageStage, type ImageStageProps } from "./ImageStage";
import { InstallProgressOverlay } from "./InstallProgressOverlay";
import { Button } from "./ui";
import { useFonts } from "../fonts/useFonts";
import { useWorkspaceZoomStyle } from "../hooks/useWorkspaceZoomStyle";

type AppWorkspaceProps = {
  workspacePanelRef: React.RefObject<HTMLElement | null>;
  workspaceZoom: number;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  selectedPageImagePageId: string | null;
  imageRef: ImageStageProps["imageRef"];
  stageRef: ImageStageProps["stageRef"];
  stageSize: ImageStageProps["stageSize"];
  selectedBlockId: string | null;
  selectedBlockIds: string[];
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

// useFonts() subscribes to custom-font changes so overlay text re-resolves
// families when fonts load/register.
export function AppWorkspace(props: AppWorkspaceProps): React.JSX.Element {
  const { workspacePanelRef } = props;
  useFonts();
  const zoomStyle = useWorkspaceZoomStyle(
    props.workspaceZoom,
    props.selectedPage,
    workspacePanelRef,
  );
  const textLayoutStageSize = React.useMemo<ImageStageProps["stageSize"]>(
    () =>
      props.selectedPage
        ? { width: props.selectedPage.width, height: props.selectedPage.height }
        : props.stageSize,
    [props.selectedPage, props.stageSize],
  );
  useResetWorkspaceScrollOnRenderedPage({
    pageId: props.selectedPage?.id ?? null,
    renderedImagePageId: props.selectedPageImagePageId,
    workspacePanelRef,
  });
  return (
    <section
      ref={workspacePanelRef}
      className={`workspace ${zoomStyle.className}`.trim()}
      style={zoomStyle.style}
      tabIndex={0}
      aria-label="읽기 영역"
      onMouseDown={() => workspacePanelRef.current?.focus()}
    >
      {props.selectedPage ? (
        <WorkspacePane
          blockPointerDisabled={props.inpaintingToolActive}
          dragHud={props.dragHud}
          imageDataUrl={props.selectedPageImageDataUrl}
          imageRef={props.imageRef}
          inpaintingMode={props.inpaintingMode}
          maskStrokes={props.maskStrokes}
          onBlockPointerDown={props.onBlockPointerDown}
          onStagePointerDown={props.onStagePointerDown}
          onStagePointerLeave={props.onStagePointerLeave}
          onStagePointerMove={props.onStagePointerMove}
          onStagePointerUp={props.onStagePointerUp}
          onToggleBlockExcluded={props.onToggleBlockExcluded}
          page={props.selectedPage}
          regionSelectionActive={props.regionSelectionActive}
          regionSelectionRect={props.regionSelectionRect}
          retouchCursor={props.retouchCursor}
          retouchPreview={props.retouchPreviewLayer}
          selectedBlockId={props.selectedBlockId}
          selectedBlockIds={props.selectedBlockIds}
          showBlockChrome={props.showBlockChrome && !props.inpaintingToolActive}
          showingOriginalPeek={props.showingOriginalPeek}
          showTextBlocks={props.showTextBlocks}
          stageRef={props.stageRef}
          stageSize={props.stageSize}
          textLayoutStageSize={textLayoutStageSize}
        />
      ) : (
        <EmptyWorkspace
          onOpenBatchImport={props.onOpenBatchImport}
          onOpenSettings={props.onOpenSettings}
          onOpenShareImport={props.onOpenShareImport}
          onOpenTranslationSource={props.onOpenTranslationSource}
        />
      )}
      <InstallProgressOverlay
        job={props.jobState}
        snapshot={props.progressSnapshot}
      />
    </section>
  );
}

function useResetWorkspaceScrollOnRenderedPage({
  pageId,
  renderedImagePageId,
  workspacePanelRef,
}: {
  pageId: string | null;
  renderedImagePageId: string | null;
  workspacePanelRef: React.RefObject<HTMLElement | null>;
}): void {
  const lastResetPageIdRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    if (!pageId) {
      lastResetPageIdRef.current = null;
      return;
    }
    if (renderedImagePageId !== pageId) {
      return;
    }
    if (lastResetPageIdRef.current === pageId) {
      return;
    }
    const panel = workspacePanelRef.current;
    if (panel) {
      panel.scrollTop = 0;
    }
    lastResetPageIdRef.current = pageId;
  }, [pageId, renderedImagePageId, workspacePanelRef]);
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
