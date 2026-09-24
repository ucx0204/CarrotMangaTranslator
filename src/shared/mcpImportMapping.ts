import { z } from "zod/v4";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z
  .object({
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256,
    format: z.enum(["png", "jpeg", "webp"]),
  })
  .strict();
export const McpImportMappingReviewSchema = z
  .object({
    selectionFingerprint: sha256,
    itemKeys: z.array(sha256).min(1).max(50),
    maxChapters: z.number().int().min(1).max(10),
    maxPages: z.number().int().min(1).max(50),
  })
  .strict()
  .refine(
    (value) =>
      value.itemKeys.length === value.maxPages &&
      new Set(value.itemKeys).size === value.itemKeys.length,
    "Import mapping review must identify every selected page exactly once.",
  );
export type McpImportMappingReview = z.infer<
  typeof McpImportMappingReviewSchema
>;
export const McpImportPublicationMetadataSchema = z
  .object({
    workId: id,
    workSha256: sha256,
    guideSha256: sha256.nullable(),
    chapters: z
      .array(
        z
          .object({
            chapterId: id,
            sha256,
            memorySha256: sha256.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.chapters.map((chapter) => chapter.chapterId)).size ===
      value.chapters.length,
    "Import publication chapter metadata must be distinct.",
  );
export const McpImportPageMappingSchema = z
  .object({
    version: z.literal(1),
    selectionFingerprint: sha256,
    chapterPageCounts: z.array(z.number().int().min(0).max(50)).min(1).max(10),
    sourceArchiveSha256: sha256.optional(),
    /** Legacy mappings remain inspectable; new composite imports require this publication proof. */
    publication: McpImportPublicationMetadataSchema.optional(),
    items: z
      .array(
        z
          .object({
            itemKey: sha256,
            chapterIndex: z.number().int().min(0).max(9),
            pageIndex: z.number().int().min(0).max(49),
            source: digest,
            original: digest,
            page: z
              .object({
                workId: id,
                chapterId: id,
                pageId: id,
                revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
                reviewRevision: z
                  .string()
                  .regex(/^page-v1:[a-f0-9]{16}$/)
                  .optional(),
                blockCount: z.number().int().nonnegative(),
                blockIdsSha256: sha256,
                filesSha256: sha256,
              })
              .strict(),
          })
          .strict()
          .refine(
            (item) =>
              item.source.format === "webp"
                ? item.original.format === "png"
                : item.source.format === item.original.format &&
                  item.source.bytes === item.original.bytes &&
                  item.source.sha256 === item.original.sha256,
            "Imported original must match its source or the native WebP-to-PNG normalization.",
          ),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine((value) => {
    const keys = value.items.map((item) => item.itemKey);
    const pages = value.items.map(
      ({ page }) => `${page.workId}/${page.chapterId}/${page.pageId}`,
    );
    return (
      new Set(keys).size === keys.length && new Set(pages).size === pages.length
    );
  }, "Imported page keys and saved page identities must be distinct.");
export type McpImportPageMapping = z.infer<typeof McpImportPageMappingSchema>;

/** Legacy receipts have no mapping and remain inspectable; they cannot bind new targets. */
export function matchesMcpImportPageMapping(receipt: {
  workId: string;
  chapterIds: string[];
  pageCount: number;
  pageMapping?: McpImportPageMapping;
}) {
  const mapping = receipt.pageMapping;
  if (!mapping) return true;
  if (mapping.chapterPageCounts.length !== receipt.chapterIds.length)
    return false;
  if (!matchesPublicationMetadata(mapping.publication, receipt)) return false;
  const counts = receipt.chapterIds.map(() => 0);
  let chapter = 0;
  for (const item of mapping.items) {
    if (item.chapterIndex < chapter) return false;
    chapter = item.chapterIndex;
    if (
      item.page.workId !== receipt.workId ||
      item.page.chapterId !== receipt.chapterIds[chapter] ||
      item.pageIndex !== counts[chapter]
    )
      return false;
    counts[chapter] += 1;
  }
  return (
    mapping.items.length === receipt.pageCount &&
    counts.every((count, index) => count === mapping.chapterPageCounts[index])
  );
}

function matchesPublicationMetadata(
  publication: McpImportPageMapping["publication"],
  receipt: { workId: string; chapterIds: string[] },
) {
  if (!publication) return true;
  return (
    publication.workId === receipt.workId &&
    publication.chapters.length === receipt.chapterIds.length &&
    publication.chapters.every(
      (chapter, index) => chapter.chapterId === receipt.chapterIds[index],
    )
  );
}
