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
  })
  .strict();

export const PanelCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("updateBlock"),
      patch: TranslationBlockSchema.partial().strict(),
    })
    .strict(),
  z.object({ type: z.literal("deleteBlock") }).strict(),
  z.object({ type: z.literal("duplicateBlock") }).strict(),
  z
    .object({
      type: z.literal("applyFormat"),
      scope: z.enum(["selection", "page", "chapter"]),
      groupIds: z.array(BlockFormatGroupIdSchema).max(20),
    })
    .strict(),
  z.object({ type: z.literal("startAreaTranslate") }).strict(),
]);
