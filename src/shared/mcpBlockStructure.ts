import { z } from "zod/v4";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";
import { McpEditableFieldsSchema } from "./mcpBlockEditing";

const { chapterId, pageId, blockId, revision, sourceRect } =
  McpSourceRectPatchSchema.shape;
const text = z.string().max(20000);
const part = z
  .object({
    sourceText: text,
    translatedText: text,
    sourceRect,
    renderRect: sourceRect,
  })
  .strict();
const textPolicy = z.enum(["preserve", "replace"]).default("preserve");
/** Precise arguments are authored by the AI after inspecting the page, not by the user. */
export const McpStructurePreviewSchema = z
  .object({
    chapterId,
    pageId,
    revision,
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
    operation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("delete"), blockId }).strict(),
      z
        .object({
          kind: z.literal("split"),
          blockId,
          parts: z.tuple([part, part]),
          textPolicy,
        })
        .strict(),
      z
        .object({
          kind: z.literal("merge"),
          blockIds: z.tuple([blockId, blockId]),
          styleFromBlockId: blockId,
          result: part,
          textPolicy,
        })
        .strict(),
    ]),
  })
  .strict();
export type McpStructurePreview = z.infer<typeof McpStructurePreviewSchema>;
export const McpStructureGetSchema = z.object({ editId: z.uuid() }).strict();
export const McpStructureActionSchema = z
  .object({
    editId: z.uuid(),
    revision,
    requestId: z.uuid(),
  })
  .strict();
export type McpStructureAction = z.infer<typeof McpStructureActionSchema>;
export type McpStructureDirection = "apply" | "undo" | "redo";
const state = z.enum(["proposed", "applied", "undone"]);
const publicBlock = z
  .object({
    id: blockId,
    sourceText: text,
    translatedText: text,
    sourceRect,
    renderRect: z
      .object({
        x: z.number(),
        y: z.number(),
        w: z.number().positive(),
        h: z.number().positive(),
      })
      .strict(),
    fields: McpEditableFieldsSchema,
    sourceDirection: z.enum(["horizontal", "vertical"]),
    speakerId: z.string().optional(),
    glossaryEntryIds: z.array(z.string()).optional(),
  })
  .strict();
const view = z
  .object({
    editId: z.uuid(),
    chapterId,
    pageId,
    kind: z.enum(["split", "merge", "delete"]),
    reason: z.string(),
    state,
    baseRevision: revision,
    currentRevision: revision.nullable(),
    expectedRevision: revision,
    expiresAt: z.number().int(),
    canApply: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    blockedReason: z
      .enum(["revision_conflict", "page_missing", "busy"])
      .nullable(),
    before: z.array(publicBlock).max(2),
    after: z.array(publicBlock).max(2),
    beforeBlockOrder: z.array(blockId),
    afterBlockOrder: z.array(blockId),
    idMapping: z
      .array(z.object({ from: blockId, to: z.array(blockId).max(2) }).strict())
      .max(2),
    warnings: z.array(z.string()),
  })
  .strict();
const receipt = z
  .object({
    editId: z.uuid(),
    chapterId,
    pageId,
    revision,
    requestId: z.uuid(),
    direction: z.enum(["apply", "undo", "redo"]),
    state,
    status: z.enum(["saved", "already_applied"]),
    pagesChanged: z.union([z.literal(0), z.literal(1)]),
    historical: z.boolean(),
  })
  .strict();
export type McpStructureReceipt = z.infer<typeof receipt>;
export const mcpStructureOutputs = {
  carrot_preview_block_structure_edit: view,
  carrot_get_block_structure_edit: view,
  carrot_apply_block_structure_edit: receipt,
  carrot_undo_block_structure_edit: receipt,
  carrot_redo_block_structure_edit: receipt,
};
