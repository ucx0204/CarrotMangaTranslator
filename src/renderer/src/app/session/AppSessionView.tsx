import React from "react";
import { AppModals } from "../../components/AppModals";
import { AppRightRail } from "../../components/AppRightRail";
import { AppSidebar } from "../../components/AppSidebar";
import { AppWorkspace } from "../../components/AppWorkspace";
import { CommandPalette } from "../../components/CommandPalette";
import { GatherTextModal } from "../../components/GatherTextModal";
import { ShortcutHelp } from "../../components/ShortcutHelp";
import { StyleGuideModal } from "../../components/StyleGuideModal";
import { TranslationOptionsModal } from "../../components/TranslationOptionsModal";
import { ToastViewport } from "../../components/ui/ToastViewport";
import { InpaintingSessionProvider } from "../../inpainting/InpaintingSessionProvider";

export type AppSessionViewProps = {
  commandPaletteProps: React.ComponentProps<typeof CommandPalette>;
  gatherTextProps: React.ComponentProps<typeof GatherTextModal> | null;
  inpaintingContextValue: React.ComponentProps<
    typeof InpaintingSessionProvider
  >["value"];
  inpaintingMode: boolean;
  modalsProps: React.ComponentProps<typeof AppModals>;
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
  commandPaletteProps,
  gatherTextProps,
  inpaintingContextValue,
  inpaintingMode,
  modalsProps,
  rightRailProps,
  shortcutHelpProps,
  sidebarProps,
  styleGuideProps,
  translationOptionsProps,
  workspaceProps,
}: AppSessionViewProps): React.JSX.Element {
  return (
    <>
      <main className={`app-shell ${inpaintingMode ? "inpainting-mode" : ""}`}>
        <AppSidebar {...sidebarProps} />
        <AppWorkspace {...workspaceProps} />
        <InpaintingSessionProvider value={inpaintingContextValue}>
          <AppRightRail {...rightRailProps} />
        </InpaintingSessionProvider>
        <AppModals {...modalsProps} />
      </main>
      <SessionFloatingOverlays
        commandPaletteProps={commandPaletteProps}
        gatherTextProps={gatherTextProps}
        shortcutHelpProps={shortcutHelpProps}
        styleGuideProps={styleGuideProps}
        translationOptionsProps={translationOptionsProps}
      />
    </>
  );
}

function SessionFloatingOverlays({
  commandPaletteProps,
  gatherTextProps,
  shortcutHelpProps,
  styleGuideProps,
  translationOptionsProps,
}: Pick<
  AppSessionViewProps,
  | "commandPaletteProps"
  | "gatherTextProps"
  | "shortcutHelpProps"
  | "styleGuideProps"
  | "translationOptionsProps"
>): React.JSX.Element {
  return (
    <>
      <CommandPalette {...commandPaletteProps} />
      <ShortcutHelp {...shortcutHelpProps} />
      {gatherTextProps ? <GatherTextModal {...gatherTextProps} /> : null}
      {styleGuideProps ? <StyleGuideModal {...styleGuideProps} /> : null}
      {translationOptionsProps ? (
        <TranslationOptionsModal {...translationOptionsProps} />
      ) : null}
      <ToastViewport />
    </>
  );
}
