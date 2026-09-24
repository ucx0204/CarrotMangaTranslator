import { McpExchangeBindingSchema } from "./mcpExchangeFiles";
import { McpArtifactMimeSchema } from "./mcpOutputFormats";
import { z } from "zod/v4";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const target = z
  .object({ chapterId: id, pageId: id, revision, reviewRevision: revision })
  .strict();
export const McpRetentionListSchema = z
  .object({
    offset: count.default(0),
    limit: count.min(1).max(25).default(25),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  })
  .strict();
export const McpRetainedGetSchema = z.object({ id: z.uuid() }).strict();
export const McpRecoveryActionSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    pages: z.array(target).min(1).max(50),
  })
  .strict();
export type McpRecoveryAction = z.infer<typeof McpRecoveryActionSchema>;
export const McpRetainedDiscardSchema = z
  .object({ id: z.uuid(), confirm: z.literal(true) })
  .strict();
const descriptor = z
  .object({
    id: z.uuid(),
    kind: z.enum(["change", "output"]),
    operation: z.string().max(128),
    requestId: z.string().max(128).nullable(),
    createdAt: count,
    expiresAt: count,
    storageBytes: count,
    pageCount: count,
    mimeType: McpArtifactMimeSchema.nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    available: z.boolean(),
  })
  .strict();
const window = z
  .object({
    snapshot: z.string().regex(/^[a-f0-9]{16}$/),
    total: count,
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    items: z.array(descriptor).max(25),
    retention: z.literal(
      "seven-days; same-profile-and-owner; no-automatic-reexecution",
    ),
  })
  .strict();
const receipt = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    direction: z.enum(["undo", "redo"]),
    status: z.enum(["saved", "already_applied"]),
    historical: z.boolean(),
    warnings: z.array(z.string()),
    pages: z.array(target).max(50),
  })
  .strict();
export const mcpRetentionOutputs = {
  carrot_list_context_proposals: window.extend({
    items: z
      .array(
        descriptor.extend({
          kind: z.literal("research-proposal"),
          pageCount: z.literal(0),
          mimeType: z.null(),
          sha256: z.null(),
        }),
      )
      .max(25),
  }),
  carrot_list_changes: window,
  carrot_list_outputs: window,
  carrot_get_change: descriptor
    .extend({
      pages: z
        .array(
          target.extend({
            matchesBefore: z.boolean(),
            matchesAfter: z.boolean(),
            changedFields: z.array(z.string()).max(20),
          }),
        )
        .max(50),
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      warnings: z.array(z.string()),
    })
    .strict(),
  carrot_undo_change: receipt,
  carrot_redo_change: receipt,
  carrot_get_output: descriptor
    .extend({
      bytes: count,
      exchange: McpExchangeBindingSchema.optional(),
      pages: z.array(target.omit({ reviewRevision: true })).max(50),
      canDownload: z.boolean(),
      warnings: z.array(z.string()),
    })
    .strict(),
  carrot_get_output_file: z
    .object({
      id: z.uuid(),
      url: z.url(),
      mimeType: McpArtifactMimeSchema,
      bytes: count,
      sha256: z.string(),
      expiresAt: count,
      access: z.string(),
    })
    .strict(),
  carrot_discard_retained: z
    .object({
      id: z.uuid(),
      status: z.literal("discarded"),
      pageChanges: z.literal(0),
    })
    .strict(),
};
