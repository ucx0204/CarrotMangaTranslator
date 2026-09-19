import { z } from "zod";
import { LibraryChapterFileSchema } from "../../shared/ipcLibrarySchemas";

export const MCP_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MCP_RETENTION_CAPACITY = 256;
export const MCP_RETENTION_BYTES = 1024 * 1024 * 1024;
export const MCP_RETAINED_FILE_BYTES = 128 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^page-v1:[a-f0-9]{16}$/);
const page = LibraryChapterFileSchema.shape.pages.element.innerType().pick({
  id: true,
  imagePath: true,
  width: true,
  height: true,
  blocks: true,
  blockOrder: true,
  soundEffectReview: true,
  translationCompletion: true,
  inpaintedImagePath: true,
  inpaintMaskPath: true,
  maskProvenance: true,
});
export const RetainedFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    sha256: hash,
    bytes: count.max(MCP_RETAINED_FILE_BYTES),
    asset: hash.nullable(),
  })
  .strict();
export type RetainedFile = z.infer<typeof RetainedFileSchema>;
const state = z
  .object({
    page,
    files: z.array(RetainedFileSchema).min(1).max(3),
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
  })
  .strict();
export type RetainedPageState = z.infer<typeof state>;
const entry = z
  .object({
    id: z.string().uuid(),
    owner: id,
    kind: z.enum(["change", "output"]),
    operation: z.string().min(1).max(128),
    requestId: z.string().max(128).nullable(),
    createdAt: count,
    expiresAt: count,
    bytes: count.max(MCP_RETENTION_BYTES),
    pageCount: count.min(1).max(50),
    mimeType: z.enum(["image/png", "application/zip"]).nullable(),
    sha256: hash.nullable(),
  })
  .strict();
export type RetentionEntry = z.infer<typeof entry>;
export const RetentionIndexSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(entry).max(MCP_RETENTION_CAPACITY),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.entries.map((item) => item.id)).size ===
      value.entries.length,
    "Duplicate retained IDs",
  );
export type RetentionIndex = z.infer<typeof RetentionIndexSchema>;
const target = z
  .object({ chapterId: id, pageId: id, revision, reviewRevision: revision })
  .strict();
const action = z
  .object({
    requestId: z.string().uuid(),
    signature: z.string(),
    direction: z.enum(["undo", "redo"]),
    pages: z.array(target).max(50),
  })
  .strict();
export const RetainedChangeSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    owner: id,
    pages: z
      .array(
        z
          .object({
            workId: id,
            chapterId: id,
            membership: z.string(),
            before: state,
            after: state,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    actions: z.array(action).max(32),
  })
  .strict();
export type RetainedChange = z.infer<typeof RetainedChangeSchema>;
export const RetainedOutputSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    owner: id,
    mimeType: z.enum(["image/png", "application/zip"]),
    sha256: hash,
    bytes: count.max(MCP_RETAINED_FILE_BYTES),
    targets: z
      .array(
        z
          .object({
            workId: id,
            chapterId: id,
            pageId: id,
            revision,
            files: z.array(RetainedFileSchema).min(1).max(3),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type RetainedOutput = z.infer<typeof RetainedOutputSchema>;
