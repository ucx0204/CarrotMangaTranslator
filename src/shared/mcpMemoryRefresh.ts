import { z } from "zod/v4";
import { mcpContextMigrationOutputs } from "./mcpContextMigration";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const fingerprint = z.string().regex(/^[a-f0-9]{16}$/);
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const count = z.number().int().nonnegative();
const status = z.enum([
  "current",
  "stale",
  "unknown",
  "missing",
  "duplicate",
  "orphan",
]);
const target = z
  .object({
    chapterId: id,
    pageId: id,
    revision,
    sourceFingerprint: fingerprint,
    translationFingerprint: fingerprint,
    summary: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("native-excerpt") }).strict(),
      z
        .object({
          kind: z.literal("reviewed-page-text"),
          text: z.string().trim().min(1).max(1200),
        })
        .strict(),
    ]),
  })
  .strict();

export const McpMemoryInspectSchema = z
  .object({
    chapterId: id,
    issuesOnly: z.boolean().default(false),
    offset: count.max(201000).default(0),
    limit: count.min(1).max(100).default(25),
    snapshot: fingerprint.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.offset > 0 && !input.snapshot)
      context.addIssue({
        code: "custom",
        message: "Continuation requires the original inspection snapshot.",
      });
  });
export type McpMemoryInspect = z.infer<typeof McpMemoryInspectSchema>;

const refresh = z
  .object({
    chapterId: id,
    referenceSnapshot: fingerprint,
    pages: z.array(target).min(1).max(50),
    replaceExistingSummary: z.boolean().default(false),
  })
  .strict();
function uniqueMemoryTargets(input: {
  pages: Array<{ chapterId: string; pageId: string }>;
}) {
  const keys = input.pages.map((page) => `${page.chapterId}/${page.pageId}`);
  return new Set(keys).size === keys.length;
}
export const McpMemoryRefreshPreviewSchema = refresh.refine(
  uniqueMemoryTargets,
  { message: "Select each saved page once." },
);
export type McpMemoryRefreshPreview = z.infer<
  typeof McpMemoryRefreshPreviewSchema
>;
export const McpMemoryRefreshApplySchema = refresh
  .extend({ planFingerprint: fingerprint, requestId: z.uuid() })
  .refine(uniqueMemoryTargets, { message: "Select each saved page once." });

const row = z
  .object({
    chapterId: id,
    pageId: id,
    pageIndex: count.nullable(),
    memoryIndex: count.nullable(),
    revision: revision.nullable(),
    status,
    reasons: z.array(z.string()).max(10),
    sourceFingerprint: fingerprint.nullable(),
    translationFingerprint: fingerprint.nullable(),
    method: z.enum(["native-excerpt", "reviewed-page-text"]).nullable(),
    visualSummary: z.enum(["manual_preserved_not_verified", "not_checked"]),
  })
  .strict();

export const mcpMemoryRefreshOutputs = {
  carrot_get_memory_status: z
    .object({
      workId: id,
      anchorChapterId: id,
      referenceSnapshot: fingerprint,
      snapshot: fingerprint,
      total: count,
      offset: count,
      limit: count,
      nextOffset: count.nullable(),
      counts: z
        .object({
          current: count,
          stale: count,
          unknown: count,
          missing: count,
          duplicate: count,
          orphan: count,
        })
        .strict(),
      items: z.array(row).max(100),
      pagesChanged: z.literal(0),
      note: z.string().max(2000),
    })
    .strict(),
  carrot_preview_memory_refresh: z
    .object({
      workId: id,
      anchorChapterId: id,
      referenceSnapshot: fingerprint,
      planFingerprint: fingerprint,
      status: z.literal("preview_only"),
      pagesChanged: z.literal(0),
      items: z
        .array(
          z
            .object({
              chapterId: id,
              pageId: id,
              previousStatus: status,
              method: z.enum(["native-excerpt", "reviewed-page-text"]),
              beforeSummary: z.string().nullable(),
              afterSummary: z.string().max(1200),
              changed: z.boolean(),
              visualSummaryPreserved: z.literal(true),
            })
            .strict(),
        )
        .max(50),
      note: z.string().max(2000),
    })
    .strict(),
  carrot_apply_memory_refresh:
    mcpContextMigrationOutputs.carrot_apply_context_migration,
};
