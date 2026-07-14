import { createContext, useContext } from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type {
  BlockBackgroundApplyScope,
  FormatApplyScope,
} from "../hooks/useBlockEditingActions";

/**
 * The slice of session state + actions that dockable/poppable panels consume.
 *
 * Panels read from this context instead of receiving deep props so the same
 * panel component can render either in the main window (local provider, backed
 * by the session controllers) or in a popped-out OS window (remote provider,
 * backed by IPC snapshots + command relay). Keep this interface narrow: only
 * what panels actually need crosses the window boundary.
 */
export type PanelSessionValue = {
  /** Currently selected text block, or null when none is selected. */
  selectedBlock: TranslationBlock | null;
  /** Size of the multi-selection, for batch format apply labels. */
  selectedBlockCount: number;
  /** True when block edits are disabled (locked page or busy inpainting). */
  editorDisabled: boolean;
  /** True when the block editor is detached into a floating in-app panel. */
  editorFloating: boolean;
  /** True when the block editor is detached into its own OS window. */
  editorPoppedOut: boolean;
  /** Whether the editor should render its float / pop-out detach controls. */
  showDetachControls: boolean;
  /** Toggles the block editor between the docked rail and a floating panel. */
  onToggleEditorFloat: () => void;
  /** Opens the block editor in its own OS window. */
  onPopOutEditor: () => void;
  /** Closes the block editor OS window, docking it back into the rail. */
  onDockEditorWindow: () => void;
  /** True when "이 화 전체" format apply is unavailable (job running). */
  disableChapterApply: boolean;
  /** True when the empty editor can start an area-translate selection. */
  areaTranslateAvailable: boolean;
  /** True while an area-translate selection is in progress. */
  areaTranslateSelecting: boolean;
  /** Adjusts only the active block's font size by one pixel. */
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onUpdateBlock: (patch: Partial<TranslationBlock>) => void;
  onDeleteBlock: () => void;
  onDuplicateBlock: () => void;
  onApplyFormat: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onApplyBlockBackgroundOpacity: (scope: BlockBackgroundApplyScope) => void;
  onStartAreaTranslate: () => void;
};

export const PanelSessionContext = createContext<PanelSessionValue | null>(
  null,
);

export function usePanelSession(): PanelSessionValue {
  const value = useContext(PanelSessionContext);
  if (!value) {
    throw new Error(
      "usePanelSession must be used within a PanelSessionContext provider.",
    );
  }
  return value;
}
