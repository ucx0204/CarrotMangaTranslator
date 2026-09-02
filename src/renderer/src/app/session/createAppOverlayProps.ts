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
  commandRegistry,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["commandPaletteProps"] {
  return {
    commands: commandRegistry.paletteCommands,
    onClose: () => uiState.setCommandPaletteOpen(false),
    open: uiState.commandPaletteOpen,
  };
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
