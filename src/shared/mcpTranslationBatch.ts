import { z } from "zod/v4";
import { McpFormatFilterSchema, McpFormatViewSchema } from "./mcpFormatEditing";
import { McpSourceRectPatchSchema } from "./mcpSourceRect";

const { chapterId, pageId, blockId, revision } = McpSourceRectPatchSchema.shape;
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const window = {
  offset: count.max(1_000_000).default(0),
  limit: z.number().int().min(1).max(25).default(10),
};
/** The AI resolves vague feedback by browsing/searching, not by requesting user IDs. */
export const McpChapterTextSearchSchema = z
  .object({
    chapterId,
    mode: z.enum(["search", "browse"]),
    query: z.string().min(1).max(200).optional(),
    field: z.enum(["source", "translation", "both"]).default("both"),
    match: z.enum(["contains", "exact"]).default("contains"),
    pageIds: z.array(pageId).min(1).max(50).optional(),
    textRole: z.enum(["all", "ordinary", "sound"]).default("all"),
    reviewStatus: z
      .enum(["all", "draft", "needs_review", "reviewed"])
      .default("all"),
    generated: z.enum(["exclude", "include", "only"]).default("exclude"),
    format: McpFormatFilterSchema.optional(),
    snapshot: fingerprint.optional(),
    ...window,
  })
  .strict();
export type McpChapterTextSearch = z.infer<typeof McpChapterTextSearchSchema>;

const change = z
  .object({
    blockId,
    translatedText: z.string().max(8192),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const McpTranslationBatchPreviewSchema = z
  .object({
    chapterId,
    contextRevision: fingerprint,
    requestId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
    allowEmpty: z.boolean().default(false),
    pages: z
      .array(
        z
          .object({
            pageId,
            revision,
            edits: z.array(change).min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type McpTranslationBatchPreview = z.infer<
  typeof McpTranslationBatchPreviewSchema
>;
export const McpTranslationBatchGetSchema = z
  .object({
    batchId: z.uuid(),
    ...window,
  })
  .strict();
export const McpTranslationBatchActionSchema = z
  .object({
    batchId: z.uuid(),
    requestId: z.uuid(),
  })
  .strict();
export type McpTranslationBatchDirection = "apply" | "undo" | "redo";

const snippet = z
  .object({
    text: z.string().max(800),
    start: count,
    end: count,
    totalLength: count,
    truncated: z.boolean(),
  })
  .strict();
const neighbor = z
  .object({
    blockId,
    source: z.string().max(160),
    translation: z.string().max(160),
  })
  .strict()
  .nullable();
const hit = z
  .object({
    pageId,
    pageNumber: count,
    blockId,
    revision,
    source: snippet,
    translation: snippet,
    matches: z
      .array(
        z
          .object({
            field: z.enum(["source", "translation"]),
            start: count,
            end: count,
          })
          .strict(),
      )
      .max(40),
    matchesTruncated: z.boolean(),
    textRole: z.enum(["ordinary", "sound"]),
    reviewStatus: z.enum(["draft", "needs_review", "reviewed"]),
    hasGeneratedLettering: z.boolean(),
    editable: z.boolean(),
    format: McpFormatViewSchema,
    previous: neighbor,
    next: neighbor,
  })
  .strict();
const searchResult = z
  .object({
    chapterId,
    snapshot: fingerprint,
    contextRevision: fingerprint,
    total: count,
    excludedGenerated: count,
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    matches: z.array(hit).max(25),
    note: z.string(),
  })
  .strict();
export type McpChapterTextHit = z.infer<typeof hit>;

const status = z.enum([
  "proposed",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
const pageState = z.enum([
  "pending",
  "applied",
  "undone",
  "unchanged",
  "excluded",
]);
const pageSummary = z
  .object({
    pageId,
    expectedRevision: revision,
    state: pageState,
    changedBlocks: count,
    result: z.enum(["not_started", "saved", "failed", "cancelled"]),
    errorCode: z.string().nullable(),
  })
  .strict();
const summary = z
  .object({
    batchId: z.uuid(),
    chapterId,
    contextRevision: fingerprint,
    reason: z.string(),
    expiresAt: count,
    status,
    direction: z.enum(["apply", "undo", "redo"]).nullable(),
    activeRequestId: z.uuid().nullable(),
    cancellationRequested: z.boolean(),
    pages: z.array(pageSummary).max(50),
    totalChanges: count,
    excludedChanges: count,
    canApply: z.boolean(),
    canUndo: z.boolean(),
    canRedo: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();
const inspectedChange = z
  .object({
    pageId,
    blockId,
    sourceText: z.string(),
    previousText: z.string(),
    proposedText: z.string().max(8192),
    reason: z.string(),
    excludedReason: z.string().nullable(),
    changed: z.boolean(),
  })
  .strict();
const view = summary
  .extend({
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    changes: z.array(inspectedChange).max(25),
  })
  .strict();
const receipt = z
  .object({
    batchId: z.uuid(),
    requestId: z.uuid(),
    direction: z.enum(["apply", "undo", "redo"]),
    status: z.enum(["accepted", "already_started"]),
    historical: z.boolean(),
    note: z.string(),
  })
  .strict();
export type McpTranslationBatchReceipt = z.infer<typeof receipt>;
export const mcpTranslationBatchOutputs = {
  carrot_search_chapter_text: searchResult,
  carrot_preview_translation_batch: summary,
  carrot_get_translation_batch: view,
  carrot_apply_translation_batch: receipt,
  carrot_undo_translation_batch: receipt,
  carrot_redo_translation_batch: receipt,
  carrot_cancel_translation_batch: summary,
};
