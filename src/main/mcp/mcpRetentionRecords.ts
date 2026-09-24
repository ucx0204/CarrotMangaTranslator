import {
  MCP_ARTIFACT_MIME_TYPES,
  mcpArtifactRequiresImages,
} from "../../shared/mcpOutputFormats";
import { McpWorkFileExportBindingSchema } from "../../shared/mcpWorkFileExport";
import {
  MCP_EXCHANGE_BYTES,
  McpExchangeBindingSchema,
  mcpExchangeIdentity,
} from "../../shared/mcpExchangeFiles";
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
// Native retained records use Zod 3; the shared work-file boundary uses Zod 4.
const retainedWorkFileBinding = z.unknown().transform((value, context) => {
  const parsed = McpWorkFileExportBindingSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Invalid retained working-file export binding.",
  });
  return z.NEVER;
});
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
const retainedExchangeBinding = z.unknown().transform((value, context) => {
  const parsed = McpExchangeBindingSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Invalid retained exchange source binding.",
  });
  return z.NEVER;
});
const RetainedFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    sha256: hash,
    bytes: count.max(MCP_RETAINED_FILE_BYTES),
    asset: hash.nullable(),
  })
  .strict();
export type RetainedFile = z.infer<typeof RetainedFileSchema>;
export const RetainedPageStateSchema = z
  .object({
    page,
    files: z.array(RetainedFileSchema).min(1).max(3),
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
  })
  .strict();
export type RetainedPageState = z.infer<typeof RetainedPageStateSchema>;
const entry = z
  .object({
    id: z.string().uuid(),
    owner: id,
    kind: z.enum([
      "change",
      "output",
      "output-sync",
      "workflow",
      "composite-workflow",
      "context",
      "research-proposal",
      "research-batch",
      "import",
      "work-file-import",
      "chapter-discovery",
      "import-batch",
      "library",
      "chapter-deletion",
      "chapter-move",
      "work-deletion",
      "page-deletion",
    ]),
    operation: z.string().min(1).max(128),
    requestId: z.string().max(128).nullable(),
    createdAt: count,
    expiresAt: count,
    bytes: count.max(MCP_RETENTION_BYTES),
    pageCount: count.max(1000),
    mimeType: z.enum(MCP_ARTIFACT_MIME_TYPES).nullable(),
    sha256: hash.nullable(),
  })
  .strict()
  .superRefine(validateRetentionEntry);
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
            contextRevision: z.string().regex(/^[a-f0-9]{16}$/),
            before: RetainedPageStateSchema,
            after: RetainedPageStateSchema,
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
    mimeType: z.enum(MCP_ARTIFACT_MIME_TYPES),
    sha256: hash,
    bytes: count.max(MCP_RETAINED_FILE_BYTES),
    workFileBinding: retainedWorkFileBinding.optional(),
    exchangeBinding: retainedExchangeBinding.optional(),
    targets: z
      .array(
        z
          .object({
            workId: id,
            chapterId: id,
            pageId: id,
            revision,
            sourceNameFingerprint: hash.optional(),
            files: z.array(RetainedFileSchema).min(1).max(3),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .refine(
    (record) =>
      mcpArtifactRequiresImages(record.mimeType)
        ? record.exchangeBinding === undefined && record.targets.length > 0
        : record.exchangeBinding !== undefined &&
          record.targets.length === 0 &&
          record.bytes > 0 &&
          record.bytes <= MCP_EXCHANGE_BYTES &&
          mcpExchangeIdentity(record.exchangeBinding).mimeType ===
            record.mimeType,
    "Exchange outputs require their exact declared source binding and no image targets.",
  )
  .refine(
    (record) =>
      record.mimeType === "application/vnd.carrot.mgtshare"
        ? record.workFileBinding !== undefined &&
          record.targets.every(
            (target) =>
              target.workId === record.workFileBinding?.workId &&
              record.workFileBinding?.chapterIds.includes(target.chapterId),
          )
        : record.workFileBinding === undefined,
    "A work-file output requires matching saved work and chapter evidence.",
  );
export type RetainedOutput = z.infer<typeof RetainedOutputSchema>;

function validateChapterRecoveryEntry(
  entry: {
    kind: string;
    pageCount: number;
    mimeType: string | null;
    sha256: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    (entry.kind === "page-deletion"
      ? entry.pageCount !== 1
      : entry.pageCount > 50) ||
    entry.mimeType !== null ||
    entry.sha256 !== null
  )
    context.addIssue({
      code: "custom",
      message:
        "Chapter recovery requires zero to fifty pages and no downloadable payload.",
    });
}

function validateRetentionEntry(
  entry: {
    kind: string;
    pageCount: number;
    mimeType: string | null;
    sha256: string | null;
    operation: string;
    requestId: string | null;
  },
  context: z.RefinementCtx,
) {
  if (entry.kind === "output-sync")
    return validateOutputSyncEntry(entry, context);
  if (entry.kind === "composite-workflow")
    return validateCompositeEntry(entry, context);
  if (
    [
      "chapter-deletion",
      "chapter-move",
      "work-deletion",
      "page-deletion",
    ].includes(entry.kind)
  )
    return validateChapterRecoveryEntry(entry, context);
  validatePageEntry(entry, context);
  if (
    ["research-batch", "chapter-discovery", "import-batch", "library"].includes(
      entry.kind,
    ) &&
    entry.pageCount !== 0
  )
    context.addIssue({
      code: "custom",
      message:
        "Research batches and chapter discovery are metadata, not page changes.",
    });
}

function validateCompositeEntry(
  entry: {
    pageCount: number;
    mimeType: string | null;
    sha256: string | null;
    operation: string;
    requestId: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    entry.pageCount > 50 ||
    entry.mimeType !== null ||
    entry.sha256 !== null ||
    entry.operation !== "carrot_prepare_composite" ||
    !z.string().uuid().safeParse(entry.requestId).success
  )
    context.addIssue({
      code: "custom",
      message:
        "Composite metadata requires zero to fifty exact pages, its preparation identity and no downloadable payload.",
    });
}

function validateOutputSyncEntry(
  entry: {
    pageCount: number;
    mimeType: string | null;
    sha256: string | null;
    operation: string;
    requestId: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    entry.pageCount < 1 ||
    entry.pageCount > 50 ||
    entry.mimeType !== null ||
    entry.sha256 !== null ||
    entry.operation !== "carrot_sync_output" ||
    !z.string().uuid().safeParse(entry.requestId).success
  )
    context.addIssue({
      code: "custom",
      message:
        "Output synchronization requires one to fifty pages, its exact request identity and no downloadable payload.",
    });
}

function validatePageEntry(
  entry: {
    kind: string;
    pageCount: number;
    mimeType: string | null;
  },
  context: z.RefinementCtx,
) {
  if (entry.kind === "output" && entry.mimeType === "application/json") {
    if (entry.pageCount !== 0)
      context.addIssue({
        code: "custom",
        message:
          "Context outputs describe saved context and have no image pages.",
      });
    return;
  }
  if (
    [
      "context",
      "research-proposal",
      "research-batch",
      "chapter-discovery",
      "import-batch",
      "library",
    ].includes(entry.kind)
  )
    return;
  if (entry.pageCount < 1 || entry.pageCount > 50)
    context.addIssue({
      code: "custom",
      message:
        "Existing page, output and workflow records require one to fifty pages.",
    });
}
