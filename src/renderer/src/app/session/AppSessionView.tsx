import React from "react";
import { AppModals } from "../../components/AppModals";
import { AppRightQuickRail } from "../../components/AppRightQuickRail";
import { AppRightRail } from "../../components/AppRightRail";
import { AppSidebar } from "../../components/AppSidebar";
import { AppWorkspace } from "../../components/AppWorkspace";
import { CommandPalette } from "../../components/CommandPalette";
import { GatherTextModal } from "../../components/GatherTextModal";
import { InstallProgressOverlay } from "../../components/InstallProgressOverlay";
import {
  LibraryDropOverlay,
  type LibraryDropOverlayProps,
} from "../../components/LibraryDropOverlay";
import { ExportOptionsModal } from "../../components/ExportOptionsModal";
import { AutoInpaintingOptionsModal } from "../../components/AutoInpaintingOptionsModal";
import { PageRetranslateModal } from "../../components/PageRetranslateModal";
import { ShortcutHelp } from "../../components/ShortcutHelp";
import { StyleGuideModal } from "../../components/StyleGuideModal";
import { TranslationOptionsModal } from "../../components/TranslationOptionsModal";
import { BlockLibraryModal } from "../../components/BlockLibraryModal";
import { ToastViewport } from "../../components/ui/ToastViewport";
import { EditorFloatingLayer } from "../../panels/EditorFloatingLayer";
import {
  PanelSessionContext,
  type PanelSessionValue,
} from "../../panels/panelSession";
import { useStablePanelSessionValue } from "../../panels/useStablePanelSessionValue";
import {
  isAppModalSubtreeActive,
  isFloatingOverlaySubtreeActive,
  memoWhileInactive,
} from "./sessionRenderBoundaries";

export type AppSessionViewProps = {
  autoInpaintingOptionsProps: React.ComponentProps<
    typeof AutoInpaintingOptionsModal
  > | null;
  blockLibraryProps: React.ComponentProps<typeof BlockLibraryModal> | null;
  commandPaletteProps: React.ComponentProps<typeof CommandPalette>;
  exportOptionsProps: React.ComponentProps<typeof ExportOptionsModal> | null;
  gatherTextProps: React.ComponentProps<typeof GatherTextModal> | null;
  libraryDropOverlayProps: LibraryDropOverlayProps;
  modalsProps: React.ComponentProps<typeof AppModals>;
  pageRetranslateProps: React.ComponentProps<
    typeof PageRetranslateModal
  > | null;
  panelSessionValue: PanelSessionValue;
  rightRailProps: React.ComponentProps<typeof AppRightRail>;
  shortcutHelpProps: React.ComponentProps<typeof ShortcutHelp>;
  sidebarProps: React.ComponentProps<typeof AppSidebar>;
  styleGuideProps: React.ComponentProps<typeof StyleGuideModal> | null;
  translationOptionsProps: React.ComponentProps<
    typeof TranslationOptionsModal
  > | null;
  workspaceProps: React.ComponentProps<typeof AppWorkspace>;
};

export function AppSessionView({
  autoInpaintingOptionsProps,
  blockLibraryProps,
  commandPaletteProps,
  exportOptionsProps,
  gatherTextProps,
  libraryDropOverlayProps,
  modalsProps,
  pageRetranslateProps,
  panelSessionValue,
  rightRailProps,
  shortcutHelpProps,
  sidebarProps,
  styleGuideProps,
  translationOptionsProps,
  workspaceProps,
}: AppSessionViewProps): React.JSX.Element {
  const stablePanelSessionValue = useStablePanelSessionValue(panelSessionValue);
  const workspaceView = useWorkspaceViewState(workspaceProps);
  return (
    <PanelSessionContext.Provider value={stablePanelSessionValue}>
      <main className="app-shell">
        <AppSidebar {...sidebarProps} />
        <div className="workspace-region">
          <AppWorkspace
            {...workspaceProps}
            onEffectiveScaleChange={workspaceView.onEffectiveScaleChange}
          />
          <AppRightQuickRail
            {...rightRailProps}
            workspaceOriginalOpacityControl={
              workspaceView.originalOpacityControl
            }
            workspaceViewControls={workspaceView.controls}
          />
        </div>
        <AppRightRail {...rightRailProps} />
        <MemoizedAppModals {...modalsProps} />
      </main>
      <MemoizedEditorFloatingLayer />
      <MemoizedSessionFloatingOverlays
        autoInpaintingOptionsProps={autoInpaintingOptionsProps}
        blockLibraryProps={blockLibraryProps}
        commandPaletteProps={commandPaletteProps}
        exportOptionsProps={exportOptionsProps}
        gatherTextProps={gatherTextProps}
        pageRetranslateProps={pageRetranslateProps}
        shortcutHelpProps={shortcutHelpProps}
        styleGuideProps={styleGuideProps}
        translationOptionsProps={translationOptionsProps}
      />
      {/* App-blocking installer progress lives at the dialog layer, not inside
          the scrolling canvas, so it can never be clipped or zoomed with it. */}
      <InstallProgressOverlay
        job={workspaceProps.jobState}
        snapshot={workspaceProps.progressSnapshot}
      />
      <LibraryDropOverlay {...libraryDropOverlayProps} />
    </PanelSessionContext.Provider>
  );
}

function useWorkspaceViewState(
  workspaceProps: AppSessionViewProps["workspaceProps"],
): {
  controls: React.ComponentProps<
    typeof AppRightQuickRail
  >["workspaceViewControls"];
  originalOpacityControl: React.ComponentProps<
    typeof AppRightQuickRail
  >["workspaceOriginalOpacityControl"];
  onEffectiveScaleChange: (scale: number) => void;
} {
  const [effectiveScale, setEffectiveScale] = React.useState(
    workspaceProps.workspaceZoom,
  );
  const onEffectiveScaleChange = React.useCallback((scale: number) => {
    setEffectiveScale((current) =>
      Math.round(current * 100) === Math.round(scale * 100) ? current : scale,
    );
  }, []);
  const invokeZoom = React.useCallback(
    (action: "in" | "out" | "reset") => {
      const controller = workspaceProps.workspaceZoomControllerRef.current;
      if (controller) {
        if (action === "in") controller.zoomInAtSelection();
        else if (action === "out") controller.zoomOutAtViewport();
        else controller.resetAtViewport();
        return;
      }
      if (action === "in") workspaceProps.onZoomInWorkspace();
      else if (action === "out") workspaceProps.onZoomOutWorkspace();
      else workspaceProps.onResetWorkspaceZoom();
    },
    [workspaceProps],
  );
  return {
    controls: {
      effectiveScale,
      fitMode: workspaceProps.workspaceFitMode,
      zoom: workspaceProps.workspaceZoom,
      onChangeFitMode: workspaceProps.onChangeWorkspaceFitMode,
      onResetZoom: () => invokeZoom("reset"),
      onZoomIn: () => invokeZoom("in"),
      onZoomOut: () => invokeZoom("out"),
    },
    originalOpacityControl: {
      available: workspaceProps.originalImageOpacityAvailable,
      opacity: workspaceProps.originalImageOpacity,
      pageId: workspaceProps.selectedPage?.id ?? null,
      onChange: workspaceProps.onChangeOriginalImageOpacity,
    },
    onEffectiveScaleChange,
  };
}

function SessionFloatingOverlays({
  autoInpaintingOptionsProps,
  blockLibraryProps,
  commandPaletteProps,
  exportOptionsProps,
  gatherTextProps,
  pageRetranslateProps,
  shortcutHelpProps,
  styleGuideProps,
  translationOptionsProps,
}: Pick<
  AppSessionViewProps,
  | "autoInpaintingOptionsProps"
  | "blockLibraryProps"
  | "commandPaletteProps"
  | "exportOptionsProps"
  | "gatherTextProps"
  | "pageRetranslateProps"
  | "shortcutHelpProps"
  | "styleGuideProps"
  | "translationOptionsProps"
>): React.JSX.Element {
  return (
    <>
      {blockLibraryProps ? <BlockLibraryModal {...blockLibraryProps} /> : null}
      {autoInpaintingOptionsProps ? (
        <AutoInpaintingOptionsModal {...autoInpaintingOptionsProps} />
      ) : null}
      {commandPaletteProps.open ? (
        <CommandPalette {...commandPaletteProps} />
      ) : null}
      {shortcutHelpProps.open ? <ShortcutHelp {...shortcutHelpProps} /> : null}
      {exportOptionsProps ? (
        <ExportOptionsModal {...exportOptionsProps} />
      ) : null}
      {gatherTextProps ? <GatherTextModal {...gatherTextProps} /> : null}
      {styleGuideProps ? <StyleGuideModal {...styleGuideProps} /> : null}
      {translationOptionsProps ? (
        <TranslationOptionsModal {...translationOptionsProps} />
      ) : null}
      {pageRetranslateProps ? (
        <PageRetranslateModal {...pageRetranslateProps} />
      ) : null}
      <ToastViewport />
    </>
  );
}

const MemoizedAppModals = memoWhileInactive(AppModals, isAppModalSubtreeActive);

const MemoizedEditorFloatingLayer = React.memo(EditorFloatingLayer);

const MemoizedSessionFloatingOverlays = memoWhileInactive(
  SessionFloatingOverlays,
  isFloatingOverlaySubtreeActive,
);
