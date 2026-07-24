import React from "react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import {
  isBlockEditingTool,
  isRetouchTool,
  type WorkspaceTool,
} from "../lib/stageTool";
import { ImageStage, type ImageStageProps } from "./ImageStage";
import { CanvasActionBar } from "./CanvasActionBar";
import { InstallProgressOverlay } from "./InstallProgressOverlay";
import { StageToolbar } from "./StageToolbar";
import { Button } from "./ui/Button";
import { useFonts } from "../fonts/useFonts";
import { useWorkspaceZoomStyle } from "../hooks/useWorkspaceZoomStyle";
import { formatCombo } from "../lib/shortcuts/comboFromEvent";
import type { WorkspaceFitMode } from "../lib/workspaceZoom";
import { WorkspaceViewControls } from "./WorkspaceViewControls";

type AppWorkspaceProps = {
  workspacePanelRef: React.RefObject<HTMLElement | null>;
  workspaceFitMode: WorkspaceFitMode;
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
  showingOriginalPeek: boolean;
  canRedo: boolean;
  canUndo: boolean;
  compareAvailable: boolean;
  resetAvailable: boolean;
  redoLabel?: string | null;
  undoLabel?: string | null;
  brushColor: string;
  brushRadius: number;
  retouchCursor: ImageStageProps["retouchCursor"];
  retouchOriginalImageDataUrl: string;
  maskStrokes: ImageStageProps["maskStrokes"];
  regionSelectionActive: boolean;
  regionTranslationAvailable: boolean;
  regionSelectionRect: ImageStageProps["regionSelectionRect"];
  blockCreateRect: ImageStageProps["blockCreateRect"];
  stageTool: WorkspaceTool;
  stageToolbarHidden: boolean;
  dragHud: ImageStageProps["dragHud"];
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
  onBlockPointerDown: ImageStageProps["onBlockPointerDown"];
  onPeekToggle: () => void;
  onRedo: () => void;
  onResetPage: () => void;
  onUndo: () => void;
  onOpenTranslationSource: () => void;
  onOpenBatchImport: () => void;
  onOpenShareImport: () => void;
  onOpenSettings: () => void;
};

// useFonts() subscribes to custom-font changes so overlay text re-resolves
// families when fonts load/register.
export function AppWorkspace(props: AppWorkspaceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { workspacePanelRef } = props;
  useFonts();
  const zoomStyle = useWorkspaceZoomStyle(
    props.workspaceZoom,
    props.workspaceFitMode,
    props.selectedPage,
    workspacePanelRef,
  );
  useResetWorkspaceScrollOnRenderedPage({
    pageId: props.selectedPage?.id ?? null,
    renderedImagePageId: props.selectedPageImagePageId,
    workspacePanelRef,
  });
  return (
    <section className="workspace-shell">
      <div
        ref={workspacePanelRef as React.RefObject<HTMLDivElement | null>}
        className={`workspace ${zoomStyle.className}`.trim()}
        style={zoomStyle.style}
        tabIndex={0}
        aria-label={t("workspace.readingArea")}
        onMouseDown={() => workspacePanelRef.current?.focus()}
      >
        <WorkspaceContent {...props} />
        <InstallProgressOverlay
          job={props.jobState}
          snapshot={props.progressSnapshot}
        />
      </div>
      {props.selectedPage ? (
        <>
          <CanvasActionBar
            canRedo={props.canRedo}
            canUndo={props.canUndo}
            compareAvailable={props.compareAvailable}
            disabled={props.jobActive}
            resetAvailable={props.resetAvailable}
            peeking={props.showingOriginalPeek}
            redoLabel={props.redoLabel}
            undoLabel={props.undoLabel}
            onPeekToggle={props.onPeekToggle}
            onRedo={props.onRedo}
            onResetPage={props.onResetPage}
            onUndo={props.onUndo}
          />
          <StageToolbar
            brushColor={props.brushColor}
            brushRadius={props.brushRadius}
            disabled={props.jobActive}
            hidden={props.stageToolbarHidden}
            onSelectTool={props.onSelectStageTool}
            onToggleRegionTranslation={props.onToggleRegionTranslation}
            onToggleHidden={props.onToggleStageToolbarHidden}
            regionTranslationActive={props.regionSelectionActive}
            regionTranslationAvailable={props.regionTranslationAvailable}
            tool={props.stageTool}
          />
          <WorkspaceViewControls
            fitMode={props.workspaceFitMode}
            zoom={props.workspaceZoom}
            onChangeFitMode={props.onChangeWorkspaceFitMode}
            onResetZoom={props.onResetWorkspaceZoom}
            onZoomIn={props.onZoomInWorkspace}
            onZoomOut={props.onZoomOutWorkspace}
          />
        </>
      ) : null}
    </section>
  );
}

function WorkspaceContent(props: AppWorkspaceProps): React.JSX.Element {
  const retouchToolActive = isRetouchTool(props.stageTool);
  const textLayoutStageSize = React.useMemo<ImageStageProps["stageSize"]>(
    () =>
      props.selectedPage
        ? { width: props.selectedPage.width, height: props.selectedPage.height }
        : props.stageSize,
    [props.selectedPage, props.stageSize],
  );
  if (!props.selectedPage) {
    return (
      <EmptyWorkspace
        onOpenBatchImport={props.onOpenBatchImport}
        onOpenSettings={props.onOpenSettings}
        onOpenShareImport={props.onOpenShareImport}
        onOpenTranslationSource={props.onOpenTranslationSource}
      />
    );
  }
  return (
    <WorkspacePane
      blockCreateRect={props.blockCreateRect}
      blockPointerDisabled={
        props.jobActive || !isBlockEditingTool(props.stageTool)
      }
      dragHud={props.dragHud}
      imageDataUrl={props.selectedPageImageDataUrl}
      imageRef={props.imageRef}
      maskStrokes={props.maskStrokes}
      onBlockPointerDown={props.onBlockPointerDown}
      onStagePointerDown={props.onStagePointerDown}
      onStagePointerLeave={props.onStagePointerLeave}
      onStagePointerMove={props.onStagePointerMove}
      onStagePointerUp={props.onStagePointerUp}
      page={props.selectedPage}
      regionSelectionActive={props.regionSelectionActive}
      regionSelectionRect={props.regionSelectionRect}
      retouchCursor={props.retouchCursor}
      retouchOriginalImageDataUrl={props.retouchOriginalImageDataUrl}
      selectedBlockId={props.selectedBlockId}
      selectedBlockIds={props.selectedBlockIds}
      showBlockChrome={props.showBlockChrome && !retouchToolActive}
      showingOriginalPeek={props.showingOriginalPeek}
      showTextBlocks={props.showTextBlocks}
      stageRef={props.stageRef}
      stageSize={props.stageSize}
      stageTool={props.stageTool}
      textLayoutStageSize={textLayoutStageSize}
    />
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
      panel.scrollLeft = 0;
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
  const { t } = useTranslation("components");
  return (
    <div className="workspace-pane">
      {showingOriginalPeek ? (
        <div className="peek-original-badge">{t("common.original")}</div>
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
  const { t } = useTranslation("components");
  return (
    <div className="empty-state">
      <div className="empty-card">
        <h2>{t("workspace.empty.title")}</h2>
        <p>{t("workspace.empty.description")}</p>
        <EmptyWorkspaceSteps
          onOpenSettings={onOpenSettings}
          onOpenTranslationSource={onOpenTranslationSource}
        />
        <div className="empty-actions">
          <Button variant="primary" onClick={onOpenTranslationSource}>
            {t("workspace.empty.startTranslation")}
          </Button>
          <Button onClick={onOpenBatchImport}>
            {t("sidebar.batchTranslate")}
          </Button>
          <Button onClick={onOpenShareImport}>
            {t("workspace.empty.importSharedCopy")}
          </Button>
        </div>
        <p className="empty-hints">
          <kbd>←</kbd> <kbd>→</kbd> {t("workspace.empty.hints.pageNavigation")}{" "}
          ·{" "}
          {formatCombo("ctrl+k").map((key, index) => (
            <React.Fragment key={`${key}-${index}`}>
              {index > 0 ? "+" : null}
              <kbd>{key}</kbd>
            </React.Fragment>
          ))}{" "}
          {t("workspace.empty.hints.commandPalette")} · <kbd>?</kbd>{" "}
          {t("workspace.empty.hints.shortcuts")}
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
  const { t } = useTranslation("components");
  return (
    <ol className="empty-steps">
      <li>
        <span className="empty-step-num">1</span>
        <div className="empty-step-body">
          <strong>{t("workspace.empty.steps.engine.title")}</strong>
          <span>{t("workspace.empty.steps.engine.description")}</span>
        </div>
        <Button size="sm" onClick={onOpenSettings}>
          {t("workspace.empty.openSettings")}
        </Button>
      </li>
      <li>
        <span className="empty-step-num">2</span>
        <div className="empty-step-body">
          <strong>{t("workspace.empty.steps.import.title")}</strong>
          <span>{t("workspace.empty.steps.import.description")}</span>
        </div>
        <Button size="sm" onClick={onOpenTranslationSource}>
          {t("common.import")}
        </Button>
      </li>
      <li>
        <span className="empty-step-num">3</span>
        <div className="empty-step-body">
          <strong>{t("workspace.empty.steps.edit.title")}</strong>
          <span>{t("workspace.empty.steps.edit.description")}</span>
        </div>
      </li>
    </ol>
  );
}
