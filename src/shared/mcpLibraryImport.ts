import { z } from "zod/v4";
import { McpImportPageMappingSchema } from "./mcpImportMapping";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const title = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const source = z.enum(["local", "web"]);
export const McpChooseImportSchema = z
  .object({
    requestId: z.uuid(),
    source: z.literal("local"),
    kind: z.enum(["images", "folder", "chapter-folder", "archive", "pdf"]),
    allowNativePreparation: z.boolean().default(false),
  })
  .strict();
export const McpScanImportSchema = z
  .object({
    requestId: z.uuid(),
    source: z.literal("web"),
    url: z.string().min(1).max(4096),
    allowNetwork: z.literal(true),
  })
  .strict();
export const McpImportCreateSchema = z
  .object({
    requestId: z.uuid(),
    previewId: z.uuid(),
    snapshot: hash,
    allowNativePreparation: z.literal(true),
    duplicatePolicy: z.enum(["allow", "reject-known"]).optional(),
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("new"), title }).strict(),
      z
        .object({ mode: z.literal("existing"), workId: id, snapshot: hash })
        .strict(),
    ]),
    chapters: z
      .array(
        z
          .object({
            draftId: z.uuid(),
            title,
            pageIds: z.array(z.uuid()).min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const drafts = value.chapters.map((chapter) => chapter.draftId);
    const pages = value.chapters.flatMap((chapter) => chapter.pageIds);
    if (
      new Set(drafts).size !== drafts.length ||
      new Set(pages).size !== pages.length ||
      pages.length > 50
    )
      context.addIssue({
        code: "custom",
        message: "Choose distinct drafts and at most fifty distinct pages.",
      });
  });
export type McpImportCreate = z.infer<typeof McpImportCreateSchema>;
export type McpChooseImport = z.infer<typeof McpChooseImportSchema>;
export type McpScanImport = z.infer<typeof McpScanImportSchema>;
export const McpImportInspectSchema = z
  .object({
    previewId: z.uuid(),
    snapshot: hash,
    offset: count.default(0),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict();
export const McpImportDiscardSchema = z
  .object({ previewId: z.uuid(), confirm: z.literal(true) })
  .strict();
export const McpImportReceiptGetSchema = z
  .object({ requestId: z.uuid() })
  .strict();
export const McpImportTargetSchema = z.object({ workId: id }).strict();
export const McpImportPreviewReferenceSchema = z
  .object({
    previewId: z.uuid(),
    snapshot: hash,
    source,
    chapterCount: z.number().int().min(1).max(10),
    pageCount: z.number().int().min(1).max(500),
    sourceBytes: count.max(256 * 1024 * 1024),
    expiresAt: count,
    retention: z.literal("session-only"),
  })
  .strict();
export const McpImportReceiptSchema = z
  .object({
    id: z.uuid(),
    requestId: z.uuid(),
    status: z.literal("imported"),
    workId: id,
    chapterIds: z.array(id).min(1).max(10),
    pageCount: z.number().int().min(1).max(50),
    source,
    createdAt: count,
    expiresAt: count,
    retention: z.literal("seven-days"),
    pageMapping: McpImportPageMappingSchema.optional(),
    batch: z
      .object({
        id: z.uuid(),
        items: z
          .array(
            z
              .object({
                itemId: z.uuid(),
                previewId: z.uuid(),
                chapterIds: z.array(id).min(1).max(10),
                pageCount: z.number().int().min(1).max(50),
              })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict()
      .optional(),
  })
  .strict();
export type McpImportReceipt = z.infer<typeof McpImportReceiptSchema>;
export const mcpLibraryImportOutputs = {
  carrot_get_import_target: z
    .object({
      workId: id,
      title: z.string().max(1000),
      snapshot: hash,
      chapterCount: count,
    })
    .strict(),
  carrot_get_import_preview: McpImportPreviewReferenceSchema.extend({
    status: z.enum(["ready", "checking", "importing", "imported"]),
    total: count,
    offset: count,
    limit: count,
    nextOffset: count.nullable(),
    pages: z
      .array(
        z
          .object({
            pageId: z.uuid(),
            draftId: z.uuid(),
            name: z.string().max(260),
            chapterTitle: z.string().max(240),
            pageIndex: count,
            sourceKind: z.enum([
              "images",
              "folder",
              "zip",
              "rar",
              "pdf",
              "zip-folder",
            ]),
          })
          .strict(),
      )
      .max(25),
    warnings: z.array(z.string().max(1000)).max(10),
  }).strict(),
  carrot_get_import_receipt: McpImportReceiptSchema.extend({
    availableChapterIds: z.array(id).max(10),
    note: z.literal(
      "Historical import receipt; current chapter existence is not content equality or permission to undo.",
    ),
  }).strict(),
  carrot_discard_import_preview: z
    .object({
      previewId: z.uuid(),
      status: z.literal("discarded"),
      pagesChanged: z.literal(0),
    })
    .strict(),
};
