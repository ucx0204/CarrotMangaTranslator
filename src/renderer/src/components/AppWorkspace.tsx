import React from "react";
import { useTranslation } from "react-i18next";
import { CanvasActionBar } from "./CanvasActionBar";
import { InstallProgressOverlay } from "./InstallProgressOverlay";
import { StageToolbar } from "./StageToolbar";
import { useWorkspaceZoomStyle } from "../hooks/useWorkspaceZoomStyle";
import { WorkspaceViewControls } from "./WorkspaceViewControls";
import { useEventCallback } from "../hooks/useEventCallback";
import type { AppWorkspaceProps } from "./appWorkspaceTypes";
import { WorkspaceContent } from "./WorkspaceContent";

export function AppWorkspace(props: AppWorkspaceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { workspacePanelRef } = props;
  const stableActions = useStableWorkspaceActions(props);
  const stableProps = { ...props, ...stableActions };
  const zoomStyle = useWorkspaceZoomStyle({
    containerRef: workspacePanelRef,
    fitMode: props.workspaceFitMode,
    imageRef: props.imageRef,
    imageRevision: props.selectedPageImageDataUrl,
    page: props.selectedPage,
    zoom: props.workspaceZoom,
  });
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
        onPointerDownCapture={() => workspacePanelRef.current?.focus()}
      >
        <WorkspaceContent {...stableProps} />
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

type WorkspaceContentActions = Pick<
  AppWorkspaceProps,
  | "onBlockPointerDown"
  | "onOpenBatchImport"
  | "onOpenSettings"
  | "onOpenShareImport"
  | "onOpenTranslationSource"
  | "onStagePointerDown"
  | "onStagePointerLeave"
  | "onStagePointerMove"
  | "onStagePointerUp"
>;

function useStableWorkspaceActions(
  props: AppWorkspaceProps,
): WorkspaceContentActions {
  const onStagePointerLeave = useEventCallback(
    (event: React.PointerEvent): void => {
      props.onStagePointerLeave?.(event);
    },
  );
  return {
    onBlockPointerDown: useEventCallback(props.onBlockPointerDown),
    onOpenBatchImport: useEventCallback(props.onOpenBatchImport),
    onOpenSettings: useEventCallback(props.onOpenSettings),
    onOpenShareImport: useEventCallback(props.onOpenShareImport),
    onOpenTranslationSource: useEventCallback(props.onOpenTranslationSource),
    onStagePointerDown: useEventCallback(props.onStagePointerDown),
    onStagePointerLeave,
    onStagePointerMove: useEventCallback(props.onStagePointerMove),
    onStagePointerUp: useEventCallback(props.onStagePointerUp),
  };
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
