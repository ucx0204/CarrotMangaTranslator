import React from "react";
import { useTranslation } from "react-i18next";
import { InstallProgressOverlay } from "./InstallProgressOverlay";
import { StageToolbar } from "./StageToolbar";
import { useWorkspaceZoomStyle } from "../hooks/useWorkspaceZoomStyle";
import { WorkspaceViewControls } from "./WorkspaceViewControls";
import { useEventCallback } from "../hooks/useEventCallback";
import type { AppWorkspaceProps } from "./appWorkspaceTypes";
import { BubbleLayoutContextBar } from "./BubbleLayoutContextBar";
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
      {props.selectedPage ? (
        <BubbleLayoutContextBar
          interactionPreviewStore={props.interactionPreviewStore}
          onApply={stableActions.onApplyBubbleLayoutDraft}
          onCancel={stableActions.onCancelBubbleLayoutDraft}
          onUndoPoint={stableActions.onUndoBubbleLayoutPoint}
        />
      ) : null}
      <WorkspaceCanvasViewport
        props={props}
        readingAreaLabel={t("workspace.readingArea")}
        stableProps={stableProps}
        zoomStyle={zoomStyle}
      />
    </section>
  );
}

function WorkspaceCanvasViewport({
  props,
  readingAreaLabel,
  stableProps,
  zoomStyle,
}: {
  props: AppWorkspaceProps;
  readingAreaLabel: string;
  stableProps: AppWorkspaceProps;
  zoomStyle: ReturnType<typeof useWorkspaceZoomStyle>;
}): React.JSX.Element {
  const { workspacePanelRef } = props;
  return (
    <div className="workspace-canvas-viewport">
      <div
        ref={workspacePanelRef as React.RefObject<HTMLDivElement | null>}
        className={`workspace ${zoomStyle.className}`.trim()}
        style={zoomStyle.style}
        tabIndex={0}
        aria-label={readingAreaLabel}
        onPointerDownCapture={() => workspacePanelRef.current?.focus()}
      >
        <WorkspaceContent {...stableProps} />
        <InstallProgressOverlay
          job={props.jobState}
          snapshot={props.progressSnapshot}
        />
      </div>
      {props.selectedPage ? <WorkspaceCanvasChrome props={props} /> : null}
    </div>
  );
}

function WorkspaceCanvasChrome({
  props,
}: {
  props: AppWorkspaceProps;
}): React.JSX.Element {
  return (
    <>
      <StageToolbar
        bubbleLayoutAvailable={hasSelectedBubbleLayoutTarget(props)}
        brushColor={props.brushColor}
        brushRadius={props.brushRadius}
        disabled={props.jobActive}
        hidden={props.stageToolbarHidden}
        lastRetouchTool={props.lastRetouchTool}
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
  );
}

function hasSelectedBubbleLayoutTarget(props: AppWorkspaceProps): boolean {
  return Boolean(
    props.selectedBlockId &&
    props.selectedPage?.blocks.some(
      (block) => block.id === props.selectedBlockId,
    ),
  );
}

type WorkspaceContentActions = Pick<
  AppWorkspaceProps,
  | "onBlockPointerDown"
  | "onWarpTransformCommit"
  | "onApplyBubbleLayoutDraft"
  | "onCancelBubbleLayoutDraft"
  | "onOpenBatchImport"
  | "onOpenSettings"
  | "onOpenShareImport"
  | "onOpenTranslationSource"
  | "onStagePointerDown"
  | "onStagePointerLeave"
  | "onStagePointerMove"
  | "onStagePointerUp"
  | "onUndoBubbleLayoutPoint"
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
    onApplyBubbleLayoutDraft: useEventCallback(props.onApplyBubbleLayoutDraft),
    onBlockPointerDown: useEventCallback(props.onBlockPointerDown),
    onWarpTransformCommit: useEventCallback((blockId, transform) =>
      props.onWarpTransformCommit?.(blockId, transform),
    ),
    onCancelBubbleLayoutDraft: useEventCallback(
      props.onCancelBubbleLayoutDraft,
    ),
    onOpenBatchImport: useEventCallback(props.onOpenBatchImport),
    onOpenSettings: useEventCallback(props.onOpenSettings),
    onOpenShareImport: useEventCallback(props.onOpenShareImport),
    onOpenTranslationSource: useEventCallback(props.onOpenTranslationSource),
    onStagePointerDown: useEventCallback(props.onStagePointerDown),
    onStagePointerLeave,
    onStagePointerMove: useEventCallback(props.onStagePointerMove),
    onStagePointerUp: useEventCallback(props.onStagePointerUp),
    onUndoBubbleLayoutPoint: useEventCallback(props.onUndoBubbleLayoutPoint),
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
