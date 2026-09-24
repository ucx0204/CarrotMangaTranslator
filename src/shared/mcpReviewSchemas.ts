import { z } from "zod/v4";
import { PAGE_IMAGE_EXPORT_PREFLIGHT_ISSUE_CODES } from "./pageImageExportTypes";

export const mcpReviewFilter = z.enum([
  "all",
  "attention",
  "untranslated",
  "unreviewed",
  "failed",
  "no-blocks",
]);
const count = z.number().int().nonnegative();
const text = z.string();
const counts = z
  .object({
    blocks: count,
    untranslated: count,
    missingSource: count,
    unreviewed: count,
    soundEffects: count,
    excludedFromErasure: count,
    staleLettering: count,
  })
  .strict();
const page = z
  .object({
    pageId: text,
    pageIndex: count,
    revision: text.regex(/^page-v1:[a-f0-9]{16}$/),
    analysisStatus: z.enum(["idle", "running", "completed", "failed"]),
    postprocessStatus: z.enum(["pending", "completed", "failed"]).nullable(),
    counts,
    references: z
      .object({
        original: z.boolean(),
        cleaned: z.boolean(),
        mask: z.boolean(),
      })
      .strict(),
    concerns: z.array(
      z.enum([
        "no-blocks",
        "untranslated",
        "unreviewed",
        "failed",
        "postprocess-pending",
        "stale-lettering",
      ]),
    ),
  })
  .strict();
const window = {
  total: count,
  offset: count,
  limit: count,
  nextOffset: count.nullable(),
};
const snapshot = text.regex(/^[a-f0-9]{16}$/);
export const mcpReviewOutputSchemas = {
  carrot_get_chapter_review: z
    .object({
      chapterId: text,
      workId: text,
      snapshot,
      filter: mcpReviewFilter,
      scope: z.literal("saved-metadata-only"),
      ...window,
      summary: z
        .object({
          pages: count,
          attention: count,
          noBlocks: count,
          untranslated: count,
          unreviewed: count,
          failed: count,
          postprocessPending: count,
          staleLettering: count,
        })
        .strict(),
      pages: z.array(page),
    })
    .strict(),
  carrot_preflight_page_export: z
    .object({
      chapterId: text,
      pageId: text,
      revision: text.regex(/^page-v1:[a-f0-9]{16}$/),
      scope: z.literal("saved-metadata-and-app-export-rules"),
      issues: z.array(
        z
          .object({
            code: z.enum(PAGE_IMAGE_EXPORT_PREFLIGHT_ISSUE_CODES),
            severity: z.enum(["warning", "info"]),
          })
          .strict(),
      ),
      counts,
      checked: z.array(text),
      notChecked: z.array(text),
      executionReserved: z.literal(false),
    })
    .strict(),
};
export type McpReviewFilter = z.infer<typeof mcpReviewFilter>;
export type McpPageReview = z.infer<typeof page>;
