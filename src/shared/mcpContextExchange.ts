import { z } from "zod/v4";
import {
  MCP_EXCHANGE_BYTES,
  McpContextExchangeBindingSchema,
} from "./mcpExchangeFiles";
import {
  McpContextPreviewSchema,
  mcpContextOutputSchemas,
} from "./mcpContextEditing";
import { mcpContextMigrationOutputs } from "./mcpContextMigration";

const id = McpContextExchangeBindingSchema.shape.chapterId;
const fingerprint = McpContextExchangeBindingSchema.shape.snapshot;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const uuid = z.string().uuid();
const [glossary, character, rules, memory] =
  McpContextPreviewSchema.shape.changes.element.options;
const distinct = <T extends z.ZodType>(schema: T, max: number) =>
  z
    .array(schema)
    .min(1)
    .max(max)
    .refine(
      (values) => new Set(values).size === values.length,
      "Use distinct fields.",
    );

/** Derive writable fields from the existing native context-edit admission. */
const McpContextImportSelectionSchema = z.discriminatedUnion("entity", [
  glossary
    .omit({ values: true })
    .required({ entryId: true })
    .extend({ fields: distinct(glossary.shape.values.keyof(), 6) }),
  character
    .omit({ values: true })
    .required({ entryId: true })
    .extend({ fields: distinct(character.shape.values.keyof(), 9) }),
  rules
    .omit({ values: true })
    .extend({ fields: distinct(rules.shape.values.keyof(), 3) }),
  memory
    .omit({ values: true })
    .extend({ fields: distinct(memory.shape.values.keyof(), 4) }),
]);
export type McpContextImportSelection = z.infer<
  typeof McpContextImportSelectionSchema
>;
const selections = z
  .array(McpContextImportSelectionSchema)
  .min(1)
  .max(100)
  .superRefine((items, context) => {
    const keys = items.map((item) =>
      item.entity === "rules"
        ? "rules"
        : `${item.entity}:${item.entity === "memory" ? item.pageId : item.entryId}`,
    );
    if (
      new Set(keys).size !== keys.length ||
      new Set(items.map((item) => item.changeId)).size !== items.length
    )
      context.addIssue({
        code: "custom",
        message: "Use distinct change IDs and targets.",
      });
  });

export const McpContextExportPreflightSchema =
  McpContextExchangeBindingSchema.omit({
    kind: true,
    snapshot: true,
  });
export type McpContextExportPreflight = z.infer<
  typeof McpContextExportPreflightSchema
>;
export const McpContextExportSchema = McpContextExportPreflightSchema.extend({
  sourceSnapshot: fingerprint,
  requestId: uuid,
});
export type McpContextExport = z.infer<typeof McpContextExportSchema>;

const intent = { chapterId: id, uploadId: uuid, requestId: uuid, selections };
export const McpContextImportPreviewSchema = z
  .object({
    ...intent,
    offset: count.max(100).default(0),
    limit: count.min(1).max(25).default(10),
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
export type McpContextImportPreview = z.infer<
  typeof McpContextImportPreviewSchema
>;
export const McpContextImportApplySchema = z
  .object({
    ...intent,
    sourceSha256: sha256,
    referenceSnapshot: fingerprint,
    planFingerprint: fingerprint,
    selectedChangeIds: distinct(id, 100),
  })
  .strict();
export type McpContextImportApply = z.infer<typeof McpContextImportApplySchema>;

export const McpContextExportReviewSchema =
  McpContextExportPreflightSchema.extend({
    format: z.literal("carrot-work-context-v1"),
    sourceSnapshot: fingerprint,
    sourceBytes: count.min(1).max(MCP_EXCHANGE_BYTES),
    sha256,
    presence: z
      .object({ guide: z.boolean(), memory: z.boolean().optional() })
      .strict(),
    counts: z
      .object({
        glossary: count.max(1000),
        characters: count.max(300),
        memoryPages: count.max(2000),
      })
      .strict(),
    warnings: z.array(z.string().max(300)).max(20),
  });
const McpContextImportDiagnosticSchema = z
  .object({
    category: z.enum([
      "identity",
      "metadata",
      "memory-evidence",
      "unselected",
      "native-normalization",
      "manual-visual-summary",
    ]),
    reason: z.string().max(300),
    count,
  })
  .strict();
export type McpContextImportDiagnostic = z.infer<
  typeof McpContextImportDiagnosticSchema
>;
export const McpContextImportReviewSchema = z
  .object({
    uploadId: uuid,
    requestId: uuid,
    workId: id,
    chapterId: id,
    sourceBytes: count.min(1).max(MCP_EXCHANGE_BYTES),
    sourceSha256: sha256,
    uploadExpiresAt: count,
    referenceSnapshot: fingerprint,
    planFingerprint: fingerprint,
    targetMode: z.literal("partial-native-context"),
    retention: z.literal("requires-live-upload-until-apply"),
    totalChanges: count.max(100),
    offset: count.max(100),
    limit: count.min(1).max(25),
    nextOffset: count.max(100).nullable(),
    changes: mcpContextOutputSchemas.carrot_get_context_proposal.shape.changes,
    diagnostics: z.array(McpContextImportDiagnosticSchema).max(10),
    warnings: z.array(z.string().max(300)).max(20),
  })
  .strict();
export const mcpContextExchangeOutputs = {
  carrot_preflight_context_export: McpContextExportReviewSchema,
  carrot_preview_context_import: McpContextImportReviewSchema,
  carrot_apply_context_import:
    mcpContextMigrationOutputs.carrot_apply_context_migration,
};
