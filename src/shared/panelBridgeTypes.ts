import type { TranslationBlock } from "./textTypes";
import type { BlockFormatGroupId } from "./blockFormat";
import type { BlockStylePresetSummary } from "./blockStylePresets";
import type { BlockLibraryEntryV1 } from "./blockLibrary";

/**
 * Panels that can be popped out into their own OS window. Kept as a closed
 * union so both the main process registry and the renderer route agree on the
 * set. Extend as more panels gain pop-out support.
 */
export type PanelId = "editor";

/** Canvas modes surfaced by the compact transform editor. */
export type TransformEditorMode = "select" | "perspective" | "curve" | "warp";

/** Mirrors the renderer's FormatApplyScope without importing renderer code. */
type PanelFormatScope = "selection" | "page" | "chapter";

/**
 * Serializable snapshot the main window broadcasts to popped-out panel windows.
 * This is the subset of the panel session that must cross the window boundary;
 * action functions and in-app-only layout flags stay in the main window.
 */
export type PanelSyncState = {
  selectedBlock: TranslationBlock | null;
  selectedBlockCount: number;
  editorDisabled: boolean;
  disableChapterApply: boolean;
  areaTranslateAvailable: boolean;
  areaTranslateSelecting: boolean;
  transformMode: TransformEditorMode;
  selectedPageSize: { width: number; height: number } | null;
  blockStylePresets: BlockStylePresetSummary[];
};

/**
 * A command sent from a popped-out panel window back to the main window, which
 * applies it through the existing session action handlers.
 */
export type PanelCommand =
  | {
      type: "updateBlock";
      blockId: string;
      patch: Partial<TranslationBlock>;
    }
  | { type: "adjustFontSize"; blockId: string; adjustment: -1 | 1 }
  | { type: "deleteBlock"; blockId: string }
  | { type: "duplicateBlock"; blockId: string }
  | { type: "openBlockLibrary" }
  | { type: "insertBlockLibraryEntry"; entry: BlockLibraryEntryV1 }
  | { type: "eraseBlockOriginal"; blockId: string }
  | { type: "fitBlockBubble"; blockId: string }
  | { type: "removeBubbleLayout"; blockId: string }
  | { type: "selectTransformMode"; mode: TransformEditorMode }
  | {
      type: "applyFormat";
      scope: PanelFormatScope;
      groupIds: BlockFormatGroupId[];
    }
  | { type: "applyStylePreset"; blockId: string; presetId: string }
  | { type: "deleteStylePreset"; presetId: string }
  | {
      type: "applyBlockBackgroundOpacity";
      scope: Exclude<PanelFormatScope, "selection">;
    }
  | { type: "startAreaTranslate" };
