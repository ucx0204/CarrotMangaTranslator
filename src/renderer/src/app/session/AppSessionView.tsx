import React from "react";
import { AppModals } from "../../components/AppModals";
import { AppRightRail } from "../../components/AppRightRail";
import { AppSidebar } from "../../components/AppSidebar";
import { AppWorkspace } from "../../components/AppWorkspace";
import { CommandPalette } from "../../components/CommandPalette";
import { GatherTextModal } from "../../components/GatherTextModal";
import { ExportOptionsModal } from "../../components/ExportOptionsModal";
import { AutoInpaintingOptionsModal } from "../../components/AutoInpaintingOptionsModal";
import { PageRetranslateModal } from "../../components/PageRetranslateModal";
import { ShortcutHelp } from "../../components/ShortcutHelp";
import { StyleGuideModal } from "../../components/StyleGuideModal";
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
  commandPaletteProps,
  exportOptionsProps,
  gatherTextProps,
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
  return (
    <PanelSessionContext.Provider value={stablePanelSessionValue}>
      <main className="app-shell">
        <AppSidebar {...sidebarProps} />
        <AppWorkspace {...workspaceProps} />
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
        styleGuideProps={styleGuideProps}
        translationOptionsProps={translationOptionsProps}
      />
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
