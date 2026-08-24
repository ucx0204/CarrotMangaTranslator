import React from "react";
import { useTranslation } from "react-i18next";

import { StageToolbar } from "./StageToolbar";
import { useWorkspaceZoomStyle } from "../hooks/useWorkspaceZoomStyle";
import { useEventCallback } from "../hooks/useEventCallback";
import type { WorkspaceScrollOrigin } from "../lib/workspaceZoom";
import type { AppWorkspaceProps } from "./appWorkspaceTypes";
import { BubbleLayoutContextBar } from "./BubbleLayoutContextBar";
import { WorkspaceContent } from "./WorkspaceContent";
import { useWorkspaceZoomController } from "../hooks/useWorkspaceZoomController";

export function AppWorkspace(props: AppWorkspaceProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { onEffectiveScaleChange, workspacePanelRef } = props;
  const stableActions = useStableWorkspaceActions(props);
  const zoomStyle = useWorkspaceZoomStyle({
    containerRef: workspacePanelRef,
    fitMode: props.workspaceFitMode,
    imageRef: props.imageRef,
    imageRevision: props.selectedPageImageDataUrl,
    page: props.selectedPage,
    zoom: props.workspaceZoom,
  });
  React.useLayoutEffect(() => {
    if (zoomStyle.effectiveScale !== null) {
      onEffectiveScaleChange?.(zoomStyle.effectiveScale);
    }
  }, [onEffectiveScaleChange, zoomStyle.effectiveScale]);
  useResetWorkspaceScrollOnRenderedPage({
    layoutReady: zoomStyle.effectiveScale !== null,
    scrollOrigin: zoomStyle.scrollOrigin,
    pageId: props.selectedPage?.id ?? null,
    renderedImagePageId: props.selectedPageImagePageId,
    workspacePanelRef,
  });
  React.useLayoutEffect(() => {
    const panel = workspacePanelRef.current;
    if (zoomStyle.pageFits && panel) {
      panel.scrollTop = 0;
      panel.scrollLeft = 0;
    }
  }, [
    props.selectedPage?.id,
    workspacePanelRef,
    zoomStyle.effectiveScale,
    zoomStyle.pageFits,
  ]);
  useWorkspaceZoomController({
    controllerRef: props.workspaceZoomControllerRef,
    fitMode: props.workspaceFitMode,
    imageRef: props.imageRef,
    layoutHeight: zoomStyle.imageSize?.height ?? null,
    layoutWidth: zoomStyle.imageSize?.width ?? null,
    onChangeZoom: props.onChangeWorkspaceZoom,
    page: props.selectedPage,
    pageFits: zoomStyle.pageFits,
    panelRef: workspacePanelRef,
    selectedBlockId: props.selectedBlockId,
    selectedBlockIds: props.selectedBlockIds,
    zoom: props.workspaceZoom,
  });
  const stableProps: AppWorkspaceProps = {
    ...props,
    ...stableActions,
    stageSize: zoomStyle.imageSize ?? props.stageSize,
  };
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
  const lockFitScroll = zoomStyle.pageFits;
  return (
    <div className="workspace-canvas-viewport">
      <div
        ref={workspacePanelRef as React.RefObject<HTMLDivElement | null>}
        className={`workspace ${zoomStyle.className} ${lockFitScroll ? "is-fit-scroll-locked" : ""}`.trim()}
        style={zoomStyle.style}
        tabIndex={0}
        aria-label={readingAreaLabel}
        onPointerDownCapture={() => workspacePanelRef.current?.focus()}
      >
        <WorkspaceContent {...stableProps} />
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
    <StageToolbar
      bubbleLayoutAvailable={hasSelectedBubbleLayoutTarget(props)}
      brushColor={props.brushColor}
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
  const onApplyBubbleLayoutDraft = useEventCallback(
    props.onApplyBubbleLayoutDraft,
  );
  const onBlockPointerDown = useEventCallback(props.onBlockPointerDown);
  const onWarpTransformCommit = useEventCallback(
    (
      ...args: Parameters<
        NonNullable<AppWorkspaceProps["onWarpTransformCommit"]>
      >
    ) => props.onWarpTransformCommit?.(...args),
  );
  const onCancelBubbleLayoutDraft = useEventCallback(
    props.onCancelBubbleLayoutDraft,
  );
  const onOpenBatchImport = useEventCallback(props.onOpenBatchImport);
  const onOpenSettings = useEventCallback(props.onOpenSettings);
  const onOpenShareImport = useEventCallback(props.onOpenShareImport);
  const onOpenTranslationSource = useEventCallback(
    props.onOpenTranslationSource,
  );
  const onStagePointerDown = useEventCallback(props.onStagePointerDown);
  const onStagePointerMove = useEventCallback(props.onStagePointerMove);
  const onStagePointerUp = useEventCallback(props.onStagePointerUp);
  const onUndoBubbleLayoutPoint = useEventCallback(
    props.onUndoBubbleLayoutPoint,
  );
  return React.useMemo(
    () => ({
      onApplyBubbleLayoutDraft,
      onBlockPointerDown,
      onWarpTransformCommit,
      onCancelBubbleLayoutDraft,
      onOpenBatchImport,
      onOpenSettings,
      onOpenShareImport,
      onOpenTranslationSource,
      onStagePointerDown,
      onStagePointerLeave,
      onStagePointerMove,
      onStagePointerUp,
      onUndoBubbleLayoutPoint,
    }),
    [
      onApplyBubbleLayoutDraft,
      onBlockPointerDown,
      onCancelBubbleLayoutDraft,
      onOpenBatchImport,
      onOpenSettings,
      onOpenShareImport,
      onOpenTranslationSource,
      onStagePointerDown,
      onStagePointerLeave,
      onStagePointerMove,
      onStagePointerUp,
      onUndoBubbleLayoutPoint,
      onWarpTransformCommit,
    ],
  );
}

function useResetWorkspaceScrollOnRenderedPage({
  layoutReady,
  scrollOrigin,
  pageId,
  renderedImagePageId,
  workspacePanelRef,
}: {
  layoutReady: boolean;
  scrollOrigin: WorkspaceScrollOrigin | null;
  pageId: string | null;
  renderedImagePageId: string | null;
  workspacePanelRef: React.RefObject<HTMLElement | null>;
}): void {
  const lastResetPageIdRef = React.useRef<string | null>(null);
  const pendingLayoutRetryPageIdRef = React.useRef<string | null>(null);
  const lastScrollOriginRef = React.useRef<
    (WorkspaceScrollOrigin & { pageId: string }) | null
  >(null);

  React.useLayoutEffect(() => {
    syncWorkspaceScroll({
      lastResetPageIdRef,
      lastScrollOriginRef,
      layoutReady,
      pageId,
      pendingLayoutRetryPageIdRef,
      renderedImagePageId,
      scrollOrigin,
      workspacePanelRef,
    });
  }, [
    layoutReady,
    pageId,
    renderedImagePageId,
    scrollOrigin,
    workspacePanelRef,
  ]);
}

type MutableValueRef<T> = { current: T };

type WorkspaceScrollSyncInput = {
  lastResetPageIdRef: MutableValueRef<string | null>;
  lastScrollOriginRef: MutableValueRef<
    (WorkspaceScrollOrigin & { pageId: string }) | null
  >;
  layoutReady: boolean;
  pageId: string | null;
  pendingLayoutRetryPageIdRef: MutableValueRef<string | null>;
  renderedImagePageId: string | null;
  scrollOrigin: WorkspaceScrollOrigin | null;
  workspacePanelRef: React.RefObject<HTMLElement | null>;
};

function syncWorkspaceScroll(input: WorkspaceScrollSyncInput): void {
  if (!input.pageId) {
    clearWorkspaceScrollSync(input);
    return;
  }
  if (input.renderedImagePageId !== input.pageId) return;
  if (!shouldSyncWorkspaceScroll(input, input.pageId)) return;
  const panel = input.workspacePanelRef.current;
  if (panel) {
    panel.scrollTop = input.scrollOrigin?.y ?? 0;
    panel.scrollLeft = input.scrollOrigin?.x ?? 0;
  }
  recordWorkspaceScrollSync(input, input.pageId);
}

function clearWorkspaceScrollSync(input: WorkspaceScrollSyncInput): void {
  input.lastResetPageIdRef.current = null;
  input.pendingLayoutRetryPageIdRef.current = null;
  input.lastScrollOriginRef.current = null;
}

function shouldSyncWorkspaceScroll(
  input: WorkspaceScrollSyncInput,
  pageId: string,
): boolean {
  if (input.lastResetPageIdRef.current !== pageId) return true;
  if (
    input.layoutReady &&
    input.pendingLayoutRetryPageIdRef.current === pageId
  ) {
    return true;
  }
  return didWorkspaceScrollOriginChange(input, pageId);
}

function didWorkspaceScrollOriginChange(
  input: WorkspaceScrollSyncInput,
  pageId: string,
): boolean {
  if (!input.layoutReady || !input.scrollOrigin) return false;
  const previous = input.lastScrollOriginRef.current;
  if (!previous || previous.pageId !== pageId) return false;
  const originChanged =
    previous.x !== input.scrollOrigin.x || previous.y !== input.scrollOrigin.y;
  if (!originChanged) return false;
  const panel = input.workspacePanelRef.current;
  if (!panel) return true;
  // Follow a layout-origin change only while the camera is still at the last
  // origin that this hook set. A zoom anchor or a user pan deliberately moves
  // away from that point; a later ResizeObserver pass (for example when
  // scrollbars appear) must not overwrite that camera position.
  return (
    Math.abs(panel.scrollLeft - previous.x) < 0.5 &&
    Math.abs(panel.scrollTop - previous.y) < 0.5
  );
}

function recordWorkspaceScrollSync(
  input: WorkspaceScrollSyncInput,
  pageId: string,
): void {
  input.lastResetPageIdRef.current = pageId;
  input.pendingLayoutRetryPageIdRef.current = input.layoutReady ? null : pageId;
  input.lastScrollOriginRef.current =
    input.layoutReady && input.scrollOrigin
      ? { ...input.scrollOrigin, pageId }
      : null;
}
