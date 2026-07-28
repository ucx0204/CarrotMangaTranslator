import { z } from "zod";
import { ALL_BLOCK_FORMAT_GROUP_IDS } from "./blockFormat";
import { TranslationBlockSchema } from "./ipcSchemaPrimitives";

const MAX_SELECTED_BLOCK_COUNT = 100000;

export const PanelIdSchema = z.enum(["editor"]);

const BlockFormatGroupIdSchema = z.enum(
  ALL_BLOCK_FORMAT_GROUP_IDS as [string, ...string[]],
);

export const PanelSyncStateSchema = z
  .object({
    selectedBlock: TranslationBlockSchema.nullable(),
    selectedBlockCount: z.number().int().min(0).max(MAX_SELECTED_BLOCK_COUNT),
    editorDisabled: z.boolean(),
    disableChapterApply: z.boolean(),
    areaTranslateAvailable: z.boolean(),
    areaTranslateSelecting: z.boolean(),
    transformMode: z.enum(["select", "perspective", "curve"]),
    selectedPageSize: z
      .object({
        width: z.number().finite().positive().max(100000),
        height: z.number().finite().positive().max(100000),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const PanelCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("updateBlock"),
      blockId: TranslationBlockSchema.shape.id,
      patch: TranslationBlockSchema.partial().strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("adjustFontSize"),
      blockId: TranslationBlockSchema.shape.id,
      adjustment: z.union([z.literal(-1), z.literal(1)]),
    })
    .strict(),
  z
    .object({
      type: z.literal("deleteBlock"),
      blockId: TranslationBlockSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("duplicateBlock"),
      blockId: TranslationBlockSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("removeBubbleLayout"),
      blockId: TranslationBlockSchema.shape.id,
    })
    .strict(),
  z
    .object({
      type: z.literal("selectTransformMode"),
      mode: z.enum(["select", "perspective", "curve"]),
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
      type: z.literal("applyBlockBackgroundOpacity"),
      scope: z.enum(["page", "chapter"]),
    })
    .strict(),
  z.object({ type: z.literal("startAreaTranslate") }).strict(),
]);
