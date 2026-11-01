import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createBlockLibraryProps({
  blockEditingActions,
  derivedState,
  uiState,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["blockLibraryProps"] {
  return uiState.blockLibraryOpen
    ? {
        canInsert:
          Boolean(derivedState.selectedPage) &&
          !derivedState.selectedPageEditLocked &&
          !workspaceHistory.busy,
        onClose: () => uiState.setBlockLibraryOpen(false),
        onInsert: blockEditingActions.insertBlockLibraryEntry,
      }
    : null;
}

export function createCommandPaletteProps({
  settingsDialog,
  commandRegistry,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["commandPaletteProps"] {
  return {
    commands: commandRegistry.paletteCommands,
    overrides: settingsDialog.settings?.keybindings ?? {},
    onClose: () => uiState.setCommandPaletteOpen(false),
    open: uiState.commandPaletteOpen,
  };
}

/**
 * Export covers the whole chapter, so a missing page selection falls back to
 * the first page; an empty chapter yields no modal rather than a hidden one.
 */
export function createExportOptionsProps({
  core,
  derivedState,
  inpaintingActions,
  libraryActions,
  settingsDialog,
  uiState,
}: Pick<
  AppSessionViewModel,
  | "core"
  | "derivedState"
  | "inpaintingActions"
  | "libraryActions"
  | "settingsDialog"
  | "uiState"
>): AppSessionViewProps["exportOptionsProps"] {
  const currentPageId =
    derivedState.selectedPage?.id ?? core.currentChapter?.pages[0]?.id;
  return uiState.exportOptionsOpen && core.currentChapter && currentPageId
    ? {
        savedPreferences: settingsDialog.settings?.ui?.exportPreferences,
        onPersistPreferences: settingsDialog.saveExportPreferences,
        chapter: core.currentChapter,
        currentPageId,
        jobActive: false,
        kind: uiState.exportOptionsKind,
        library: core.library,
        onClose: () => uiState.setExportOptionsOpen(false),
        onNavigateToIssue: (chapterId, pageId) => {
          void (async () => {
            if (core.currentChapter?.id !== chapterId) {
              await libraryActions.openChapter(chapterId);
            }
            core.setSelectedPageId(pageId);
            core.setSelectedBlockId(null);
            uiState.setExportOptionsOpen(false);
          })();
        },
        onStart:
          uiState.exportOptionsKind === "psd"
            ? inpaintingActions.exportPagePsd
            : inpaintingActions.exportPageImages,
      }
    : null;
}

export function createShortcutHelpProps({
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["shortcutHelpProps"] {
  return {
    onClose: () => uiState.setShortcutHelpOpen(false),
    open: uiState.shortcutHelpOpen,
    overrides: settingsDialog.settings?.keybindings ?? {},
  };
}
