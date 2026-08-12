import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createCommandPaletteProps({
  commands,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["commandPaletteProps"] {
  return {
    commands,
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
