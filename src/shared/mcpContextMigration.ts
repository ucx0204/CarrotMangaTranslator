import { z } from "zod/v4";
import { McpContextPreviewSchema } from "./mcpContextEditing";
import { mcpContextReferenceOutputs } from "./mcpContextReferences";
import { mcpRetentionOutputs } from "./mcpRetention";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const entryId = z.string().min(1).max(200);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const entity = z.enum(["character", "glossary"]);
const [glossaryChange, characterChange] =
  McpContextPreviewSchema.shape.changes.element.options;
const glossary = glossaryChange.shape.values
  .required({ source: true, target: true, category: true, enabled: true })
  .extend({ id: entryId });
const character = characterChange.shape.values
  .required({
    displayName: true,
    sourceNames: true,
    targetName: true,
    speechStyle: true,
    enabled: true,
  })
  .extend({ id: entryId });
const ids = z
  .array(entryId)
  .min(1)
  .max(100)
  .refine(
    (values) => new Set(values).size === values.length,
    "Entry IDs must be distinct.",
  );
const mappings = z
  .array(z.object({ fromId: entryId, toId: entryId.nullable() }).strict())
  .max(1000);
const command = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("merge"),
      entity,
      sourceIds: ids,
      targetId: entryId,
      copyAliases: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("delete"),
      entity,
      entryIds: ids,
      unlinkReferences: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace-glossary"),
      entries: z.array(glossary).max(1000),
      mappings: mappings.default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace-characters"),
      entries: z.array(character).max(1000),
      mappings: mappings.default([]),
    })
    .strict(),
]);

/** Catalog fields and explicit IDs only; never native page snapshots or file paths. */
export const McpContextMigrationPreviewSchema = z
  .object({
    chapterId: id,
    referenceSnapshot: fingerprint,
    command,
    preserveManual: z.boolean().default(true),
    section: z.enum(["entries", "references"]).default("entries"),
    offset: count.max(200000).default(0),
    limit: count.min(1).max(100).default(25),
    planFingerprint: fingerprint.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.offset > 0 && !input.planFingerprint)
      context.addIssue({
        code: "custom",
        message: "Continuation requires the original plan fingerprint.",
      });
  });
export type McpContextMigrationPreview = z.infer<
  typeof McpContextMigrationPreviewSchema
>;
export const McpContextMigrationApplySchema = z
  .object({
    chapterId: id,
    referenceSnapshot: fingerprint,
    command,
    preserveManual: McpContextMigrationPreviewSchema.shape.preserveManual,
    planFingerprint: fingerprint,
    requestId: z.uuid(),
  })
  .strict();
export type McpContextMigrationApply = z.infer<
  typeof McpContextMigrationApplySchema
>;
export const McpContextMigrationRecoverySchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    referenceSnapshot: fingerprint,
  })
  .strict();
export type McpContextMigrationRecovery = z.infer<
  typeof McpContextMigrationRecoverySchema
>;
const deltaCounts = z
  .object({
    guideChanged: z.boolean(),
    pages: count,
    blocks: count,
    memories: count,
  })
  .strict();
const migrationReceipt = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    direction: z.enum(["apply", "undo", "redo"]),
    status: z.enum(["saved", "unchanged", "already_applied"]),
    historical: z.boolean(),
    referenceSnapshot: fingerprint,
    changes: deltaCounts,
    warnings: z.array(z.string()).max(20),
  })
  .strict();

// Output is evidence, not input normalization: preserve stored whitespace exactly.
const catalogEntry = z.union([
  glossary.extend({ source: z.string().min(1).max(400) }),
  character.extend({
    displayName: z.string().min(1).max(200),
    sourceNames: z.array(z.string().min(1).max(200)).max(50),
  }),
]);
const entryChange = z
  .object({
    entity,
    entryId,
    operation: z.enum(["added", "updated", "removed"]),
    before: catalogEntry.nullable(),
    after: catalogEntry.nullable(),
  })
  .strict();
const reference =
  mcpContextReferenceOutputs.carrot_get_context_references.shape.references.element
    .extend({ toId: entryId.nullable() })
    .strict();

export const mcpContextMigrationOutputs = {
  carrot_apply_context_migration: migrationReceipt,
  carrot_undo_context_migration: migrationReceipt,
  carrot_redo_context_migration: migrationReceipt,
  carrot_get_context_migration: z
    .object({
      id: z.uuid(),
      workId: id,
      anchorChapterId: id,
      createdAt: count,
      expiresAt: count,
      referenceSnapshot: fingerprint,
      changes: deltaCounts,
      actionsUsed: count,
      canUndo: z.boolean(),
      canRedo: z.boolean(),
      warnings: z.array(z.string()).max(20),
    })
    .strict(),
  carrot_list_context_migrations: mcpRetentionOutputs.carrot_list_changes
    .extend({
      items: z
        .array(
          mcpRetentionOutputs.carrot_list_changes.shape.items.element.extend({
            kind: z.literal("context"),
          }),
        )
        .max(25),
    })
    .strict(),
  carrot_preview_context_migration: z
    .object({
      workId: id,
      anchorChapterId: id,
      referenceSnapshot: fingerprint,
      planFingerprint: fingerprint,
      status: z.literal("preview_only"),
      section: z.enum(["entries", "references"]),
      total: count,
      offset: count,
      limit: count.min(1).max(100),
      nextOffset: count.nullable(),
      counts: z
        .object({
          entriesAdded: count,
          entriesUpdated: count,
          entriesRemoved: count,
          manualEntriesPreserved: count,
          referencesRemapped: count,
          referencesUnlinked: count,
          pagesAffected: count,
          memoryRowsAffected: count,
          orphanedMemoryRowsAffected: count,
          catalogOrderChanged: z.boolean(),
        })
        .strict(),
      entries: z.array(entryChange).max(100),
      references: z.array(reference).max(100),
      pagesChanged: z.literal(0),
      executable: z.literal(false),
      note: z.string().max(2000),
    })
    .strict(),
};
