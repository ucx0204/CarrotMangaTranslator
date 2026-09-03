import React from "react";
import { AppModals } from "../../components/AppModals";
import { AppRightQuickRail } from "../../components/AppRightQuickRail";
import { AppRightRail } from "../../components/AppRightRail";
import { AppSidebar } from "../../components/AppSidebar";
import { AppWorkspace } from "../../components/AppWorkspace";
import { CommandPalette } from "../../components/CommandPalette";
import { GatherTextModal } from "../../components/GatherTextModal";
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
import { ConditionalBatchEditor } from "../../components/ConditionalBatchEditor";
import { SoundEffectTranslationLauncher } from "../../components/SoundEffectTranslationLauncher";
import { SoundEffectTranslationModal } from "../../components/SoundEffectTranslationModal";
import { ToastViewport } from "../../components/ui/ToastViewport";
import { useEventCallback } from "../../hooks/useEventCallback";
import { isOriginalImageOpacitySupported } from "../../lib/originalImageOpacity";
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
  conditionalBatchEditorProps: React.ComponentProps<
    typeof ConditionalBatchEditor
  > | null;
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
  soundEffectLauncherProps: React.ComponentProps<
    typeof SoundEffectTranslationLauncher
  >;
  soundEffectTranslationModalProps: React.ComponentProps<
    typeof SoundEffectTranslationModal
  > | null;
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
  conditionalBatchEditorProps,
  exportOptionsProps,
  gatherTextProps,
  libraryDropOverlayProps,
  modalsProps,
  pageRetranslateProps,
  panelSessionValue,
  rightRailProps,
  shortcutHelpProps,
  sidebarProps,
  soundEffectLauncherProps,
  soundEffectTranslationModalProps,
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
        <SoundEffectTranslationLauncher {...soundEffectLauncherProps} />
        <div className="workspace-region">
          <AppWorkspace
            {...workspaceProps}
            onEffectiveScaleChange={workspaceView.onEffectiveScaleChange}
          />
          <AppRightQuickRail
            {...rightRailProps}
            regionTranslationActive={workspaceProps.regionSelectionActive}
            stageToolbarHidden={workspaceProps.stageToolbarHidden}
            workspaceOriginalOpacityControl={
              workspaceView.originalOpacityControl
            }
            workspaceViewControls={workspaceView.controls}
          />
        </div>
        <AppRightRail {...rightRailProps} />
        <MemoizedAppModals {...modalsProps} />
      </main>
      <MemoizedSessionFloatingOverlays
        autoInpaintingOptionsProps={autoInpaintingOptionsProps}
        blockLibraryProps={blockLibraryProps}
        commandPaletteProps={commandPaletteProps}
        exportOptionsProps={exportOptionsProps}
        gatherTextProps={gatherTextProps}
        pageRetranslateProps={pageRetranslateProps}
        shortcutHelpProps={shortcutHelpProps}
        soundEffectTranslationModalProps={soundEffectTranslationModalProps}
        styleGuideProps={styleGuideProps}
        translationOptionsProps={translationOptionsProps}
      />
      {conditionalBatchEditorProps ? (
        <ConditionalBatchEditor {...conditionalBatchEditorProps} />
      ) : (
        <MemoizedEditorFloatingLayer />
      )}
      <LibraryDropOverlay {...libraryDropOverlayProps} />
    </PanelSessionContext.Provider>
  );
}

type WorkspaceViewState = {
  controls: React.ComponentProps<
    typeof AppRightQuickRail
  >["workspaceViewControls"];
  originalOpacityControl: React.ComponentProps<
    typeof AppRightQuickRail
  >["workspaceOriginalOpacityControl"];
  onEffectiveScaleChange: (scale: number) => void;
};

function useWorkspaceViewState(
  workspaceProps: AppSessionViewProps["workspaceProps"],
): WorkspaceViewState {
  const [effectiveScale, setEffectiveScale] = React.useState(
    workspaceProps.workspaceZoom,
  );
  const onEffectiveScaleChange = React.useCallback((scale: number) => {
    setEffectiveScale((current) =>
      Math.round(current * 100) === Math.round(scale * 100) ? current : scale,
    );
  }, []);
  return {
    controls: useStableWorkspaceViewControls(workspaceProps, effectiveScale),
    originalOpacityControl: useStableOriginalOpacityControl(workspaceProps),
    onEffectiveScaleChange,
  };
}

function useStableWorkspaceViewControls(
  workspaceProps: AppSessionViewProps["workspaceProps"],
  effectiveScale: number,
): WorkspaceViewState["controls"] {
  const invokeZoom = useEventCallback((action: "in" | "out" | "reset") => {
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
  });
  const onChangeFitMode = useEventCallback(
    workspaceProps.onChangeWorkspaceFitMode,
  );
  const onResetZoom = React.useCallback(
    () => invokeZoom("reset"),
    [invokeZoom],
  );
  const onZoomIn = React.useCallback(() => invokeZoom("in"), [invokeZoom]);
  const onZoomOut = React.useCallback(() => invokeZoom("out"), [invokeZoom]);
  return React.useMemo(
    () => ({
      effectiveScale,
      fitMode: workspaceProps.workspaceFitMode,
      zoom: workspaceProps.workspaceZoom,
      onChangeFitMode,
      onResetZoom,
      onZoomIn,
      onZoomOut,
    }),
    [
      effectiveScale,
      onChangeFitMode,
      onResetZoom,
      onZoomIn,
      onZoomOut,
      workspaceProps.workspaceFitMode,
      workspaceProps.workspaceZoom,
    ],
  );
}

function useStableOriginalOpacityControl(
  workspaceProps: AppSessionViewProps["workspaceProps"],
): WorkspaceViewState["originalOpacityControl"] {
  const onChange = useEventCallback(
    workspaceProps.onChangeOriginalImageOpacity,
  );
  const pageId = workspaceProps.selectedPage?.id ?? null;
  const supported = isOriginalImageOpacitySupported(
    workspaceProps.selectedPage,
  );
  return React.useMemo(
    () => ({
      available: workspaceProps.originalImageOpacityAvailable,
      supported,
      opacity: workspaceProps.originalImageOpacity,
      pageId,
      onChange,
    }),
    [
      onChange,
      pageId,
      supported,
      workspaceProps.originalImageOpacity,
      workspaceProps.originalImageOpacityAvailable,
    ],
  );
}

function SessionFloatingOverlays({
  autoInpaintingOptionsProps,
  blockLibraryProps,
  commandPaletteProps,
  exportOptionsProps,
  gatherTextProps,
  pageRetranslateProps,
  shortcutHelpProps,
  soundEffectTranslationModalProps,
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
  | "soundEffectTranslationModalProps"
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
      {soundEffectTranslationModalProps ? (
        <SoundEffectTranslationModal {...soundEffectTranslationModalProps} />
      ) : null}
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
