import { useEffect } from "react";
import { isEditableTarget } from "../lib/appHelpers";

type UseGlobalHotkeysOptions = {
  /** True when a blocking overlay (settings/import/etc.) is open — suppresses opening. */
  blockingModalOpen: boolean;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  onToggleHelp: () => void;
};

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

function isPaletteShortcut(event: KeyboardEvent): boolean {
  return hasCommandModifier(event) && event.key.toLowerCase() === "k";
}

function isHelpShortcut(event: KeyboardEvent): boolean {
  return event.key === "?" || (hasCommandModifier(event) && event.key === "/");
}

function shouldIgnoreHelpShortcut(
  event: KeyboardEvent,
  { blockingModalOpen, paletteOpen }: UseGlobalHotkeysOptions,
): boolean {
  return (
    blockingModalOpen ||
    paletteOpen ||
    (event.key === "?" && isEditableTarget(event.target))
  );
}

function handleGlobalHotkey(
  event: KeyboardEvent,
  options: UseGlobalHotkeysOptions,
): void {
  if (isPaletteShortcut(event)) {
    if (!options.blockingModalOpen) {
      event.preventDefault();
      options.onTogglePalette();
    }
    return;
  }

  if (isHelpShortcut(event) && !shouldIgnoreHelpShortcut(event, options)) {
    event.preventDefault();
    options.onToggleHelp();
  }
}

/**
 * Global keyboard shortcuts not tied to page reading:
 * - Ctrl/Cmd+K toggles the command palette
 * - "?" or Ctrl+/ opens the shortcut help
 */
export function useGlobalHotkeys({
  blockingModalOpen,
  paletteOpen,
  onTogglePalette,
  onToggleHelp,
}: UseGlobalHotkeysOptions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      handleGlobalHotkey(event, {
        blockingModalOpen,
        onToggleHelp,
        onTogglePalette,
        paletteOpen,
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [blockingModalOpen, paletteOpen, onTogglePalette, onToggleHelp]);
}
