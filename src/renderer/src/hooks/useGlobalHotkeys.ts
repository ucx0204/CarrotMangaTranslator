import { useEffect } from "react";
import { isEditableTarget } from "../lib/appHelpers";

type UseGlobalHotkeysOptions = {
  /** True when a blocking overlay (settings/import/etc.) is open — suppresses opening. */
  blockingModalOpen: boolean;
  paletteOpen: boolean;
  onTogglePalette: () => void;
  onToggleHelp: () => void;
};

/**
 * Global keyboard shortcuts not tied to page reading:
 * - Ctrl/Cmd+K toggles the command palette
 * - "?" or Ctrl+/ opens the shortcut help
 */
export function useGlobalHotkeys({
  blockingModalOpen,
  paletteOpen,
  onTogglePalette,
  onToggleHelp
}: UseGlobalHotkeysOptions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key;
      const withCtrl = event.ctrlKey || event.metaKey;

      if (withCtrl && (key === "k" || key === "K")) {
        if (blockingModalOpen) {
          return;
        }
        event.preventDefault();
        onTogglePalette();
        return;
      }

      const isHelpKey = key === "?" || (withCtrl && key === "/");
      if (isHelpKey) {
        if (blockingModalOpen || paletteOpen) {
          return;
        }
        // Let users type "?" inside text fields.
        if (key === "?" && isEditableTarget(event.target)) {
          return;
        }
        event.preventDefault();
        onToggleHelp();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [blockingModalOpen, paletteOpen, onTogglePalette, onToggleHelp]);
}
