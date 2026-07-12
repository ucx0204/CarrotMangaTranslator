import type { TranslationBlock } from "./textTypes";
import type { BlockFormatGroupId } from "./blockFormat";

/**
 * Panels that can be popped out into their own OS window. Kept as a closed
 * union so both the main process registry and the renderer route agree on the
 * set. Extend as more panels gain pop-out support.
 */
export type PanelId = "editor";

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
};

/**
 * A command sent from a popped-out panel window back to the main window, which
 * applies it through the existing session action handlers.
 */
export type PanelCommand =
  | { type: "updateBlock"; patch: Partial<TranslationBlock> }
  | { type: "deleteBlock" }
  | { type: "duplicateBlock" }
  | {
      type: "applyFormat";
      scope: PanelFormatScope;
      groupIds: BlockFormatGroupId[];
    }
  | { type: "startAreaTranslate" };
