import type { TranslationBlock } from "./textTypes";
import type { BlockFormatGroupId } from "./blockFormat";
import type {
  BlockStylePresetSummary,
  CreateBlockStylePresetInput,
} from "./blockStylePresets";
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

export const PANEL_FORMAT_FIELD_KEYS = [
  "fontFamily",
  "fontSizePx",
  "autoFitText",
  "bold",
  "italic",
  "textAlign",
  "wordBreak",
  "renderDirection",
  "lineHeight",
  "letterSpacing",
  "fontWidthScale",
  "textColor",
  "textOpacity",
  "backgroundColor",
  "opacity",
  "outlineColor",
  "outlineWidthPx",
  "outlineWidthScale",
  "rotationDeg",
  "textEffect",
] as const satisfies readonly (keyof TranslationBlock)[];

type PanelFormatFieldKey = (typeof PANEL_FORMAT_FIELD_KEYS)[number];
export type PanelFormatPatch = Partial<
  Pick<TranslationBlock, PanelFormatFieldKey>
>;
export type PanelFormatSelection = {
  common: PanelFormatPatch;
  mixedFields: PanelFormatFieldKey[];
};

/**
 * Serializable snapshot the main window broadcasts to popped-out panel windows.
 * This is the subset of the panel session that must cross the window boundary;
 * action functions and in-app-only layout flags stay in the main window.
 */
export type PanelSyncState = {
  selectedBlock: TranslationBlock | null;
  selectedBlockCount: number;
  selectionKey: string;
  formatSelection: PanelFormatSelection;
  editorTextTabRequestToken: number;
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
  | {
      type: "updateSelectionFormat";
      selectionKey: string;
      patch: PanelFormatPatch;
    }
  | {
      type: "adjustSelectionFontSize";
      selectionKey: string;
      adjustment: -1 | 1;
    }
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
  | { type: "applyStylePreset"; selectionKey: string; presetId: string }
  | { type: "deleteStylePreset"; presetId: string }
  | { type: "openStylePresetManager" }
  | { type: "openFontManager" }
  | {
      type: "createStylePreset";
      selectionKey: string;
      input: CreateBlockStylePresetInput;
    }
  | {
      type: "overwriteStylePreset";
      selectionKey: string;
      presetId: string;
    }
  | {
      type: "renameStylePreset";
      presetId: string;
      name: string;
    }
  | {
      type: "applyBlockBackgroundOpacity";
      scope: Exclude<PanelFormatScope, "selection">;
    }
  | { type: "startAreaTranslate" };

export function createPanelSelectionKey(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids)].sort());
}

export function pickPanelFormatPatch(
  patch: Partial<TranslationBlock>,
): PanelFormatPatch {
  const safe: Partial<Record<PanelFormatFieldKey, unknown>> = {};
  for (const key of PANEL_FORMAT_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      safe[key] = patch[key];
    }
  }
  return safe as PanelFormatPatch;
}

export function buildPanelFormatSelection(
  blocks: readonly TranslationBlock[],
): PanelFormatSelection {
  const common: Partial<Record<PanelFormatFieldKey, unknown>> = {};
  const mixedFields: PanelFormatFieldKey[] = [];
  const first = blocks[0];
  if (!first) return { common: {}, mixedFields };
  for (const key of PANEL_FORMAT_FIELD_KEYS) {
    const value = first[key];
    if (
      blocks
        .slice(1)
        .some((block) => !panelFormatValuesEqual(value, block[key]))
    ) {
      mixedFields.push(key);
    } else if (value !== undefined) {
      common[key] = value;
    }
  }
  return { common: common as PanelFormatPatch, mixedFields };
}

function panelFormatValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}
