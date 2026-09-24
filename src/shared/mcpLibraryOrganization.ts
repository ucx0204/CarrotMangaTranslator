import { z } from "zod/v4";
import {
  McpImportTargetSchema,
  McpImportCreateSchema,
} from "./mcpLibraryImport";
import { mcpRetentionOutputs } from "./mcpRetention";

const id = McpImportTargetSchema.shape.workId;
const hash = McpImportCreateSchema.shape.snapshot;
const title = McpImportCreateSchema.shape.chapters.element.shape.title;
const ids = z
  .array(id)
  .max(2000)
  .refine(
    (values) => new Set(values).size === values.length,
    "IDs must be distinct.",
  );
const intent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rename-work"), workId: id, title }).strict(),
  z
    .object({
      kind: z.literal("rename-chapter"),
      workId: id,
      chapterId: id,
      title,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reorder-chapters"),
      workId: id,
      chapterIds: ids,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reorder-pages"),
      workId: id,
      chapterId: id,
      pageIds: ids,
    })
    .strict(),
]);
export const McpLibraryOrganizationPreviewSchema = z
  .object({ intent })
  .strict();
export const McpLibraryOrganizationApplySchema = z
  .object({
    intent,
    requestId: z.uuid(),
    snapshot: hash,
    planFingerprint: hash,
  })
  .strict();
export const McpLibraryOrganizationRecoverySchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    snapshot: hash,
  })
  .strict();
export type McpLibraryOrganizationIntent = z.infer<typeof intent>;
export type McpLibraryOrganizationApply = z.infer<
  typeof McpLibraryOrganizationApplySchema
>;
export type McpLibraryOrganizationRecovery = z.infer<
  typeof McpLibraryOrganizationRecoverySchema
>;
const count = z.number().int().nonnegative();
const value = z
  .object({
    title: z.string().max(4096).nullable(),
    chapterIds: ids,
    pageIds: ids.optional(),
    memory: z
      .object({
        present: z.boolean(),
        rows: z
          .array(
            z
              .object({
                pageId: z.string().min(1).max(200),
                pageIndex: count,
                pageName: z.string().max(4096),
              })
              .strict(),
          )
          .max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();
const receipt = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    direction: z.enum(["apply", "undo", "redo"]),
    status: z.enum(["saved", "unchanged", "already_applied"]),
    historical: z.boolean(),
    snapshot: hash,
    expiresAt: count,
    warnings: z.array(z.string().max(1000)).max(8),
  })
  .strict();
const catalog = mcpRetentionOutputs.carrot_list_changes;
export const mcpLibraryOrganizationOutputs = {
  carrot_preview_library_change: z
    .object({
      intent,
      snapshot: hash,
      planFingerprint: hash,
      changed: z.boolean(),
      before: value,
      after: value,
      warnings: z.array(z.string().max(1000)).max(8),
    })
    .strict(),
  carrot_apply_library_change: receipt,
  carrot_undo_library_change: receipt,
  carrot_redo_library_change: receipt,
  carrot_get_library_change: z
    .object({
      id: z.uuid(),
      intent,
      createdAt: count,
      expiresAt: count,
      snapshot: hash,
      changed: z.boolean(),
      applied: z.boolean(),
      actionsUsed: count.max(32),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      warnings: z.array(z.string().max(1000)).max(8),
    })
    .strict(),
  carrot_list_library_changes: catalog.extend({
    items: z
      .array(
        catalog.shape.items.element.extend({
          kind: z.literal("library"),
          pageCount: z.literal(0),
          mimeType: z.null(),
          sha256: z.null(),
        }),
      )
      .max(25),
  }),
};
