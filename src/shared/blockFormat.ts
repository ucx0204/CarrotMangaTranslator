import type { TranslationBlock } from "./textTypes";

/**
 * Single source of truth for text-block formatting:
 *  - the field registry used by the "서식 일괄 적용" picker (Part B), and
 *  - the per-user default formatting applied to newly created blocks (Part A).
 *
 * No new TranslationBlock fields are introduced here, so the strict IPC block
 * schema (ipcSchemaPrimitives.ts) does not need to change. Defaults live only in
 * settings.json.
 */

// ---------------------------------------------------------------------------
// Format field registry (batch apply)
// ---------------------------------------------------------------------------

export type BlockFormatGroupId =
  | "font"
  | "size"
  | "align"
  | "direction"
  | "emphasis"
  | "lineSpacing"
  | "letterSpacing"
  | "color"
  | "outline"
  | "transform";

type BlockFormatKey = keyof TranslationBlock;

type BlockFormatGroup = {
  id: BlockFormatGroupId;
  label: string;
  /** The TranslationBlock keys this group copies when applied. */
  keys: BlockFormatKey[];
};

export const BLOCK_FORMAT_GROUPS: readonly BlockFormatGroup[] = [
  { id: "font", label: "글꼴", keys: ["fontFamily"] },
  { id: "size", label: "글자 크기", keys: ["fontSizePx", "autoFitText"] },
  { id: "align", label: "정렬", keys: ["textAlign"] },
  { id: "direction", label: "가로/세로", keys: ["renderDirection"] },
  { id: "emphasis", label: "굵게·기울임", keys: ["bold", "italic"] },
  { id: "lineSpacing", label: "줄 간격", keys: ["lineHeight"] },
  { id: "letterSpacing", label: "자간", keys: ["letterSpacing"] },
  { id: "color", label: "글자색", keys: ["textColor"] },
  {
    id: "outline",
    label: "외곽선",
    keys: ["outlineColor", "outlineWidthScale"],
  },
  { id: "transform", label: "기울기·투명도", keys: ["rotationDeg", "opacity"] },
];

export const ALL_BLOCK_FORMAT_GROUP_IDS: BlockFormatGroupId[] =
  BLOCK_FORMAT_GROUPS.map((group) => group.id);

/** Copy only the formatting keys belonging to the selected groups. */
export function pickBlockFormat(
  block: TranslationBlock,
  groupIds: BlockFormatGroupId[],
): Partial<TranslationBlock> {
  const selected = new Set(groupIds);
  const patch: Record<string, unknown> = {};
  for (const group of BLOCK_FORMAT_GROUPS) {
    if (!selected.has(group.id)) {
      continue;
    }
    for (const key of group.keys) {
      patch[key] = block[key];
    }
  }
  return patch as Partial<TranslationBlock>;
}

// ---------------------------------------------------------------------------
// Default text-block formatting (settings)
// ---------------------------------------------------------------------------

/** "auto" keeps the pipeline's per-block horizontal/vertical detection. */
export type BlockFormatDirectionDefault = "auto" | "horizontal" | "vertical";

export type BlockFormatDefaults = {
  renderDirection: BlockFormatDirectionDefault;
  textAlign: "left" | "center" | "right";
  fontFamily?: string;
  autoFitText: boolean;
  /** Used only when autoFitText is false. */
  fontSizePx: number;
  lineHeight: number;
  letterSpacing: number;
  textColor: string;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidthScale: number;
  bold: boolean;
  italic: boolean;
};

/** Mirrors the previous hardcoded block-creation defaults in overlayItems.ts. */
export const DEFAULT_BLOCK_FORMAT_DEFAULTS: BlockFormatDefaults = {
  renderDirection: "auto",
  textAlign: "center",
  autoFitText: true,
  fontSizePx: 24,
  lineHeight: 1.18,
  letterSpacing: 0,
  textColor: "#111111",
  outlineEnabled: true,
  outlineColor: "#ffffff",
  outlineWidthScale: 1,
  bold: false,
  italic: false,
};

/**
 * Apply user default formatting onto a freshly created block. Position, text,
 * confidence, and (for "auto" direction) the pipeline-detected direction and
 * auto-fit size are preserved.
 */
export function applyFormatDefaultsToBlock(
  block: TranslationBlock,
  defaults: BlockFormatDefaults | undefined,
): TranslationBlock {
  if (!defaults) {
    return block;
  }
  const next: TranslationBlock = {
    ...block,
    textAlign: defaults.textAlign,
    lineHeight: defaults.lineHeight,
    letterSpacing: defaults.letterSpacing,
    textColor: defaults.textColor,
    bold: defaults.bold,
    italic: defaults.italic,
    autoFitText: defaults.autoFitText,
  };

  // Font family: undefined means "use the app's default font".
  if (defaults.fontFamily) {
    next.fontFamily = defaults.fontFamily;
  } else {
    delete next.fontFamily;
  }

  // Manual size only overrides the auto-fit estimate when auto-fit is off.
  if (!defaults.autoFitText) {
    next.fontSizePx = defaults.fontSizePx;
  }

  if (defaults.outlineEnabled) {
    next.outlineColor = defaults.outlineColor;
    next.outlineWidthScale = defaults.outlineWidthScale;
  } else {
    delete next.outlineColor;
    next.outlineWidthScale = 0;
  }

  // "auto" keeps the detected direction; otherwise force the chosen direction.
  if (defaults.renderDirection !== "auto") {
    next.renderDirection = defaults.renderDirection;
  }

  return next;
}
