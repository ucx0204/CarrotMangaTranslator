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
import { SearchReplaceModal } from "../../components/SearchReplaceModal";
import { TranslationOptionsModal } from "../../components/TranslationOptionsModal";
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
  searchReplaceProps: React.ComponentProps<typeof SearchReplaceModal> | null;
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
  commandPaletteProps,
  exportOptionsProps,
  gatherTextProps,
  libraryDropOverlayProps,
  modalsProps,
  pageRetranslateProps,
  panelSessionValue,
  rightRailProps,
  searchReplaceProps,
  shortcutHelpProps,
  sidebarProps,
  styleGuideProps,
  translationOptionsProps,
  workspaceProps,
}: AppSessionViewProps): React.JSX.Element {
  const stablePanelSessionValue = useStablePanelSessionValue(panelSessionValue);
  const [workspaceEffectiveScale, setWorkspaceEffectiveScale] = React.useState(
    workspaceProps.workspaceZoom,
  );
  React.useLayoutEffect(() => {
    setWorkspaceEffectiveScale(workspaceProps.workspaceZoom);
  }, [workspaceProps.selectedPage?.id, workspaceProps.workspaceZoom]);
  return (
    <PanelSessionContext.Provider value={stablePanelSessionValue}>
      <main className="app-shell">
        <AppSidebar {...sidebarProps} />
        <div className="workspace-region">
          <AppWorkspace
            {...workspaceProps}
            onEffectiveScaleChange={setWorkspaceEffectiveScale}
          />
          <AppRightQuickRail
            {...rightRailProps}
            workspaceViewControls={{
              effectiveScale: workspaceEffectiveScale,
              fitMode: workspaceProps.workspaceFitMode,
              zoom: workspaceProps.workspaceZoom,
              onChangeFitMode: workspaceProps.onChangeWorkspaceFitMode,
              onResetZoom: workspaceProps.onResetWorkspaceZoom,
              onZoomIn: workspaceProps.onZoomInWorkspace,
              onZoomOut: workspaceProps.onZoomOutWorkspace,
            }}
          />
        </div>
        <AppRightRail {...rightRailProps} />
        <MemoizedAppModals {...modalsProps} />
      </main>
      <MemoizedEditorFloatingLayer />
      <MemoizedSessionFloatingOverlays
        autoInpaintingOptionsProps={autoInpaintingOptionsProps}
        commandPaletteProps={commandPaletteProps}
        exportOptionsProps={exportOptionsProps}
        gatherTextProps={gatherTextProps}
        pageRetranslateProps={pageRetranslateProps}
        shortcutHelpProps={shortcutHelpProps}
        searchReplaceProps={searchReplaceProps}
        styleGuideProps={styleGuideProps}
        translationOptionsProps={translationOptionsProps}
      />
      <LibraryDropOverlay {...libraryDropOverlayProps} />
    </PanelSessionContext.Provider>
  );
}

function SessionFloatingOverlays({
  autoInpaintingOptionsProps,
  commandPaletteProps,
  exportOptionsProps,
  gatherTextProps,
  pageRetranslateProps,
  shortcutHelpProps,
  searchReplaceProps,
  styleGuideProps,
  translationOptionsProps,
}: Pick<
  AppSessionViewProps,
  | "autoInpaintingOptionsProps"
  | "commandPaletteProps"
  | "exportOptionsProps"
  | "gatherTextProps"
  | "pageRetranslateProps"
  | "shortcutHelpProps"
  | "searchReplaceProps"
  | "styleGuideProps"
  | "translationOptionsProps"
>): React.JSX.Element {
  return (
    <>
      {autoInpaintingOptionsProps ? (
        <AutoInpaintingOptionsModal {...autoInpaintingOptionsProps} />
      ) : null}
      {commandPaletteProps.open ? (
        <CommandPalette {...commandPaletteProps} />
      ) : null}
      {shortcutHelpProps.open ? <ShortcutHelp {...shortcutHelpProps} /> : null}
      {searchReplaceProps ? (
        <SearchReplaceModal {...searchReplaceProps} />
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
