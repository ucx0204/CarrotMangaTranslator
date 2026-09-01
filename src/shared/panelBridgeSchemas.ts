import { z } from "zod";
import { ALL_BLOCK_FORMAT_GROUP_IDS } from "./blockFormat";
import { PANEL_FORMAT_FIELD_KEYS } from "./panelBridgeTypes";
import {
  MAX_BLOCK_STYLE_PRESETS,
  MAX_BLOCK_STYLE_PRESET_ID_LENGTH,
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
} from "./blockStylePresets";
import {
  TranslationBlockObjectSchema,
  TranslationBlockSchema,
} from "./ipcSchemaPrimitives";
import { BlockLibraryEntryV1Schema } from "./blockLibrary";

const MAX_SELECTED_BLOCK_COUNT = 100000;

const TranslationBlockPatchSchema = TranslationBlockObjectSchema.omit({
  automaticFontMatch: true,
})
  .partial()
  .strict();

const PanelFormatPatchSchema = TranslationBlockObjectSchema.pick({
  fontFamily: true,
  fontSizePx: true,
  autoFitText: true,
  bold: true,
  italic: true,
  textAlign: true,
  wordBreak: true,
  renderDirection: true,
  lineHeight: true,
  letterSpacing: true,
  fontWidthScale: true,
  textColor: true,
  textOpacity: true,
  backgroundColor: true,
  opacity: true,
  outlineColor: true,
  outlineWidthPx: true,
  outlineWidthScale: true,
  rotationDeg: true,
  textEffect: true,
})
  .partial()
  .strict();

const PanelFormatFieldKeySchema = z.enum(PANEL_FORMAT_FIELD_KEYS);
const PanelSelectionKeySchema = z.string().max(25_000_000);
const BlockFormatGroupIdSchema = z.enum(
  ALL_BLOCK_FORMAT_GROUP_IDS as [string, ...string[]],
);
const CreateBlockStylePresetInputSchema = z
  .object({
    name: z.string().min(1).max(MAX_BLOCK_STYLE_PRESET_NAME_LENGTH),
    pinned: z.boolean(),
    groupIds: z.array(BlockFormatGroupIdSchema).max(20),
  })
  .strict();

export const PanelIdSchema = z.enum(["editor"]);

const BlockStylePresetSummarySchema = z
  .object({
    id: z.string().min(1).max(MAX_BLOCK_STYLE_PRESET_ID_LENGTH),
    name: z.string().min(1).max(MAX_BLOCK_STYLE_PRESET_NAME_LENGTH),
    pinned: z.boolean(),
    missingFont: z.boolean(),
  })
  .strict();

export const PanelSyncStateSchema = z
  .object({
    selectedBlock: TranslationBlockSchema.nullable(),
    selectedBlockCount: z.number().int().min(0).max(MAX_SELECTED_BLOCK_COUNT),
    selectionKey: PanelSelectionKeySchema,
    formatSelection: z
      .object({
        common: PanelFormatPatchSchema,
        mixedFields: z.array(PanelFormatFieldKeySchema).max(50),
      })
      .strict(),
    editorTextTabRequestToken: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    editorDisabled: z.boolean(),
    disableChapterApply: z.boolean(),
    areaTranslateAvailable: z.boolean(),
    areaTranslateSelecting: z.boolean(),
    transformMode: z.enum(["select", "perspective", "curve", "warp"]),
    selectedPageSize: z
      .object({
        width: z.number().finite().positive().max(100000),
        height: z.number().finite().positive().max(100000),
      })
      .strict()
      .nullable(),
    blockStylePresets: z
      .array(BlockStylePresetSummarySchema)
      .max(MAX_BLOCK_STYLE_PRESETS),
  })
  .strict();

export const PanelCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("updateBlock"),
      blockId: TranslationBlockObjectSchema.shape.id,
      patch: TranslationBlockPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("adjustFontSize"),
      blockId: TranslationBlockObjectSchema.shape.id,
      adjustment: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal("updateSelectionFormat"),
      selectionKey: PanelSelectionKeySchema,
      patch: PanelFormatPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("adjustSelectionFontSize"),
      selectionKey: PanelSelectionKeySchema,
      adjustment: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal("deleteBlock"),
      blockId: TranslationBlockObjectSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("duplicateBlock"),
      blockId: TranslationBlockObjectSchema.shape.id,
    })
    .strict(),
  z.object({ type: z.literal("openBlockLibrary") }).strict(),
  z
    .object({
      type: z.literal("insertBlockLibraryEntry"),
      entry: BlockLibraryEntryV1Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("eraseBlockOriginal"),
      blockId: TranslationBlockObjectSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("fitBlockBubble"),
      blockId: TranslationBlockObjectSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("removeBubbleLayout"),
      blockId: TranslationBlockObjectSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("selectTransformMode"),
      mode: z.enum(["select", "perspective", "curve", "warp"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("applyFormat"),
      scope: z.enum(["selection", "page", "chapter"]),
      groupIds: z.array(BlockFormatGroupIdSchema).max(20),
    })
    .strict(),
  z
    .object({
      type: z.literal("applyStylePreset"),
      selectionKey: PanelSelectionKeySchema,
      presetId: z.string().min(1).max(MAX_BLOCK_STYLE_PRESET_ID_LENGTH),
    })
    .strict(),
  z
    .object({
      type: z.literal("deleteStylePreset"),
      presetId: z.string().min(1).max(MAX_BLOCK_STYLE_PRESET_ID_LENGTH),
    })
    .strict(),
  z.object({ type: z.literal("openStylePresetManager") }).strict(),
  z
    .object({
      type: z.literal("createStylePreset"),
      selectionKey: PanelSelectionKeySchema,
      input: CreateBlockStylePresetInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("overwriteStylePreset"),
      selectionKey: PanelSelectionKeySchema,
      presetId: z.string().min(1).max(MAX_BLOCK_STYLE_PRESET_ID_LENGTH),
    })
    .strict(),
  z
    .object({
      type: z.literal("applyBlockBackgroundOpacity"),
      scope: z.enum(["page", "chapter"]),
    })
    .strict(),
  z.object({ type: z.literal("startAreaTranslate") }).strict(),
]);
