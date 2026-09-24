import { z } from "zod/v4";
import { McpDiscoveredChapterScanSchema } from "./mcpChapterDiscovery";
import {
  McpImportPreviewReferenceSchema,
  McpImportReceiptSchema,
  McpScanImportSchema,
} from "./mcpLibraryImport";
import { mcpRetentionOutputs } from "./mcpRetention";

const count = z.number().int().nonnegative();
const label = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const source = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("url"),
      url: McpScanImportSchema.shape.url,
      label,
    })
    .strict(),
  McpDiscoveredChapterScanSchema.pick({
    id: true,
    snapshot: true,
    linkId: true,
  })
    .extend({ kind: z.literal("discovered"), label })
    .strict(),
]);
export const McpImportBatchPrepareSchema = z
  .object({
    requestId: z.uuid(),
    sources: z.array(source).min(1).max(10),
    maxAttempts: count.min(1).max(30).default(30),
  })
  .strict()
  .refine(
    (value) => value.maxAttempts >= value.sources.length,
    "The attempt budget must cover the initial fixed selection.",
  );
export type McpImportBatchPrepare = z.infer<typeof McpImportBatchPrepareSchema>;
export const McpImportBatchGetSchema = z.object({ id: z.uuid() }).strict();
export const McpImportBatchRunSchema = z
  .object({
    id: z.uuid(),
    version: count,
    requestId: z.uuid(),
    allowNetwork: z.literal(true),
    retryItemIds: z.array(z.uuid()).max(10).default([]),
    rescanExpiredItemIds: z.array(z.uuid()).max(10).default([]),
    acknowledgeDiscardedReceiptRisk: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = [...value.retryItemIds, ...value.rescanExpiredItemIds];
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        message: "Retry and rescan selections must be distinct.",
      });
    if (
      value.rescanExpiredItemIds.length &&
      !value.acknowledgeDiscardedReceiptRisk
    )
      context.addIssue({
        code: "custom",
        message:
          "Rescanning needs explicit acknowledgement that discarded receipts prevent complete duplicate detection.",
      });
  });
export type McpImportBatchRun = z.infer<typeof McpImportBatchRunSchema>;
export const McpImportBatchDiscardSchema = McpImportBatchGetSchema.extend({
  confirm: z.literal(true),
}).strict();
const status = z.enum([
  "prepared",
  "running",
  "paused",
  "cancelled",
  "partial",
  "review_required",
  "completed",
  "interrupted",
  "failed",
]);
export const McpImportBatchReferenceSchema = z
  .object({
    id: z.uuid(),
    version: count,
    status,
    expiresAt: count,
    retention: z.literal("seven-days"),
    availability: z.literal("lookup-required"),
  })
  .strict();
const view = McpImportBatchReferenceSchema.extend({
  createdAt: count,
  pauseRequested: z.boolean(),
  cancellationRequested: z.boolean(),
  attemptCount: count.max(30),
  maxAttempts: count.min(1).max(30),
  errorCode: z.string().max(128).nullable(),
  items: z
    .array(
      z
        .object({
          id: z.uuid(),
          label,
          url: z.url().max(4096),
          status: z.enum([
            "pending",
            "scanning",
            "ready",
            "preview_unavailable",
            "checking",
            "importing",
            "imported",
            "failed",
            "cancelled",
            "interrupted",
          ]),
          attemptCount: count.max(30),
          errorCode: z.string().max(128).nullable(),
          preview: McpImportPreviewReferenceSchema.nullable(),
          receipt: McpImportReceiptSchema.nullable(),
        })
        .strict(),
    )
    .min(1)
    .max(10),
  warnings: z.array(z.string().max(1000)).max(8),
}).strict();
const catalog = mcpRetentionOutputs.carrot_list_context_proposals;
export const mcpImportBatchOutputs = {
  carrot_prepare_import_batch: view,
  carrot_get_import_batch: view,
  carrot_pause_import_batch: view,
  carrot_cancel_import_batch: view,
  carrot_list_import_batches: catalog
    .extend({
      items: z
        .array(
          catalog.shape.items.element.extend({
            kind: z.literal("import-batch"),
          }),
        )
        .max(25),
    })
    .strict(),
  carrot_discard_import_batch: z
    .object({
      id: z.uuid(),
      status: z.literal("discarded"),
      pageChanges: z.literal(0),
    })
    .strict(),
};
