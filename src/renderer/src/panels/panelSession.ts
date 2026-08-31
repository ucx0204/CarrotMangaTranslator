import { createContext, useContext } from "react";
import type { TranslationBlock } from "../../../shared/textTypes";
import type { BlockFormatGroupId } from "../../../shared/blockFormat";
import type { FormatApplyScope } from "../hooks/blockEditingStatus";
import type { BlockBackgroundApplyScope } from "../hooks/useApplyBlockBackgroundOpacityAction";
import type {
  PanelFormatSelection,
  TransformEditorMode,
} from "../../../shared/panelBridgeTypes";
import type {
  BlockStylePresetSummary,
  CreateBlockStylePresetInput,
} from "../../../shared/blockStylePresets";
import type { BlockLibraryEntryV1 } from "../../../shared/blockLibrary";

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
  selectionKey: string;
  formatSelection: PanelFormatSelection;
  editorTextTabRequestToken: number;
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
  /** Returns the docked inspector to the current page's block list. */
  onBackToPageBlocks: () => void;
  /** Closes the block editor OS window, docking it back into the rail. */
  onDockEditorWindow: () => void;
  /** True when "이 화 전체" format apply is unavailable (job running). */
  disableChapterApply: boolean;
  /** True when the empty editor can start an area-translate selection. */
  areaTranslateAvailable: boolean;
  /** True while an area-translate selection is in progress. */
  areaTranslateSelecting: boolean;
  /** Active canvas transform mode; only its matching controls are shown. */
  transformMode: TransformEditorMode;
  /** Source-page dimensions used for human-readable pixel values. */
  selectedPageSize: { width: number; height: number } | null;
  blockStylePresets: BlockStylePresetSummary[];
  canCreateStylePreset: boolean;
  /** Adjusts every selected block's font size by one relative step. */
  onAdjustFontSize: (adjustment: -1 | 1) => void;
  onUpdateBlock: (patch: Partial<TranslationBlock>) => void;
  onUpdateFormat: (patch: Partial<TranslationBlock>) => void;
  onDeleteBlock: () => void;
  onDuplicateBlock: () => void;
  /** Opens the block library in the owning main application window. */
  onOpenBlockLibrary: () => void;
  onSuggestConsistentEdit?: (find: string, replace: string) => void;
  onInsertBlockLibraryEntry: (entry: BlockLibraryEntryV1) => void;
  onEraseBlockOriginal: () => void;
  onFitBlockBubble: () => void;
  onRemoveBubbleLayout: () => void;
  onSelectTransformMode: (mode: TransformEditorMode) => void;
  onApplyFormat: (
    scope: FormatApplyScope,
    groupIds: BlockFormatGroupId[],
  ) => void;
  onApplyStylePreset: (presetId: string) => void;
  onCreateStylePreset: (input: CreateBlockStylePresetInput) => Promise<boolean>;
  onDeleteStylePreset: (presetId: string) => Promise<boolean>;
  onOpenStylePresetManager: () => void;
  onOpenFontManager: () => void;
  onOverwriteStylePreset: (presetId: string) => Promise<boolean>;
  onRenameStylePreset: (presetId: string, name: string) => Promise<boolean>;
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
