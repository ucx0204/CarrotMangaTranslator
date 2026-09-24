import { z } from "zod/v4";

export const MCP_OUTPUT_SYNC_LIMITS = {
  selectedPages: 50,
  mirrorChapters: 10,
  mirrorPages: 50,
  externalFiles: 301,
  registryPublications: 51,
  receiptFiles: 352,
  imageBytes: 67108864,
  mirrorBytes: 16777216,
  publishedBytes: 268435456,
} as const;
export const McpOutputSyncIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const McpOutputSyncFileIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
export const McpOutputSyncSnapshotSchema = z.string().regex(/^[a-f0-9]{16}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const pageIds = z
  .array(McpOutputSyncIdSchema)
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate page IDs.");
const McpOutputSyncSelectionSchema = z
  .object({
    chapterId: McpOutputSyncIdSchema,
    connectionId: McpOutputSyncIdSchema,
    pageIds,
  })
  .strict();
export const McpGetOutputDestinationSchema = z
  .object({
    chapterId: McpOutputSyncIdSchema,
  })
  .strict();
export const McpPreflightOutputSyncSchema = McpOutputSyncSelectionSchema;
export const McpSyncOutputSchema = McpOutputSyncSelectionSchema.extend({
  selectionSnapshot: McpOutputSyncSnapshotSchema,
  destinationSnapshot: McpOutputSyncSnapshotSchema,
  sourceSnapshot: McpOutputSyncSnapshotSchema,
  requestId: z.string().uuid(),
  confirm: z.literal(true),
  acknowledgePartialPublication: z.literal(true),
  acknowledgeSavedTextMirror: z.literal(true),
}).strict();
export const McpGetOutputSyncSchema = z.union([
  z.object({ id: z.string().uuid() }).strict(),
  z.object({ requestId: z.string().uuid() }).strict(),
]);
const McpOutputSyncErrorCodeSchema = z.enum([
  "destination_unavailable",
  "destination_changed",
  "selection_changed",
  "source_changed",
  "unmanaged_collision",
  "unsafe_path",
  "legacy_preparation_required",
  "limit_exceeded",
  "publication_failed",
  "receipt_failed",
]);
export const McpOutputSyncDigestSchema = z
  .object({
    bytes: count.max(MCP_OUTPUT_SYNC_LIMITS.imageBytes),
    sha256,
  })
  .strict();
export const McpOutputSyncFileSchema = z
  .object({
    fileId: McpOutputSyncFileIdSchema,
    role: z.enum(["result", "inpainted", "mask", "mirror", "registry"]),
    pageId: McpOutputSyncIdSchema.nullable(),
    action: z.enum(["publish", "remove"]),
    previous: McpOutputSyncDigestSchema.nullable(),
  })
  .strict();
const mirrorScope = z
  .object({
    chapters: z
      .array(
        McpOutputSyncSelectionSchema.extend({
          pageIds: z
            .array(McpOutputSyncIdSchema)
            .max(50)
            .refine(
              (ids) => new Set(ids).size === ids.length,
              "Duplicate page IDs.",
            ),
        }).strict(),
      )
      .min(1)
      .max(10),
    pageCount: count.max(50),
    includesSavedText: z.literal(true),
  })
  .strict()
  .refine(
    (scope) =>
      scope.pageCount ===
        scope.chapters.reduce(
          (sum, chapter) => sum + chapter.pageIds.length,
          0,
        ) &&
      new Set(scope.chapters.map((chapter) => chapter.connectionId)).size ===
        scope.chapters.length,
    "Invalid mirror scope.",
  );
export const McpOutputDestinationSchema = z
  .object({
    chapterId: McpOutputSyncIdSchema,
    connectionId: McpOutputSyncIdSchema.nullable(),
    destinationKind: z.enum(["managed", "custom"]).nullable(),
    enabled: z.boolean(),
    available: z.boolean(),
    reason: McpOutputSyncErrorCodeSchema.nullable(),
    output: z
      .object({
        format: z.enum(["source", "png", "jpeg", "webp"]),
        jpegQuality: z.number().int().min(1).max(100),
        webpQuality: z.number().int().min(1).max(100),
        preserveSourceNames: z.boolean(),
        destinationMode: z.enum(["timestamped", "fixed"]),
        collisionPolicy: z.enum(["replace", "skip", "cancel"]),
      })
      .strict()
      .nullable(),
    mirrorScope: mirrorScope.nullable(),
  })
  .strict();
export const McpOutputSyncPreflightSchema = McpOutputSyncSelectionSchema.extend(
  {
    selectionSnapshot: McpOutputSyncSnapshotSchema,
    destinationSnapshot: McpOutputSyncSnapshotSchema,
    sourceSnapshot: McpOutputSyncSnapshotSchema,
    pages: z
      .array(
        z
          .object({
            pageId: McpOutputSyncIdSchema,
            revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
            visualRevision: z.string().regex(/^page-visual-v1:[a-f0-9]{16}$/),
            format: z.enum(["png", "jpeg", "webp"]),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    mirrorScope,
    files: z.array(McpOutputSyncFileSchema).min(1).max(301),
    limits: z
      .object({
        selectedPages: z.literal(50),
        mirrorChapters: z.literal(10),
        mirrorPages: z.literal(50),
        externalFiles: z.literal(301),
        registryPublications: z.literal(51),
        receiptFiles: z.literal(352),
        imageBytes: z.literal(67108864),
        mirrorBytes: z.literal(16777216),
        publishedBytes: z.literal(268435456),
      })
      .strict(),
    registryPublications: z
      .object({
        maximum: count.min(1).max(51),
        privateMetadataOnly: z.literal(true),
      })
      .strict(),
    executionReserved: z.literal(false),
    partialPublication: z.literal(true),
  },
).strict();
export const McpOutputSyncEffectSchema = z
  .object({
    fileId: McpOutputSyncFileIdSchema,
    state: z.enum(["published", "removed"]),
    bytes: count.max(MCP_OUTPUT_SYNC_LIMITS.imageBytes),
    sha256: sha256.nullable(),
    completedAt: count,
  })
  .strict()
  .refine(
    (effect) =>
      effect.state === "published"
        ? effect.sha256 !== null
        : effect.bytes === 0 && effect.sha256 === null,
    "Effect digest does not match its action.",
  );
const McpOutputSyncFileOutcomeSchema = McpOutputSyncFileSchema.extend({
  state: z.enum([
    "planned",
    "publication_unconfirmed",
    "published",
    "removed",
    "failed",
  ]),
  bytes: count.max(MCP_OUTPUT_SYNC_LIMITS.imageBytes).nullable(),
  sha256: sha256.nullable(),
  completedAt: count.nullable(),
}).strict();
export const McpOutputSyncResultSchema = z
  .object({
    status: z.enum(["completed", "partial", "cancelled", "failed"]),
    errorCode: McpOutputSyncErrorCodeSchema.nullable(),
    files: z.array(McpOutputSyncFileOutcomeSchema).max(352),
    publishedBytes: count.max(MCP_OUTPUT_SYNC_LIMITS.publishedBytes),
    metadata: z.enum([
      "pending",
      "partial",
      "published",
      "publication_unconfirmed",
    ]),
    mirror: z.enum(["pending", "published", "publication_unconfirmed"]),
  })
  .strict();
export const McpOutputSyncReceiptSchema = z
  .object({
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    jobId: z.string().uuid(),
    chapterId: McpOutputSyncIdSchema,
    connectionId: McpOutputSyncIdSchema,
    pageIds,
    createdAt: count,
    expiresAt: count,
    status: z.enum([
      "running",
      "interrupted",
      "completed",
      "partial",
      "cancelled",
      "failed",
    ]),
    historical: z.boolean(),
    sourceChecked: z.literal(false),
    files: z.array(McpOutputSyncFileOutcomeSchema).max(352),
    publishedBytes: count.max(MCP_OUTPUT_SYNC_LIMITS.publishedBytes),
    reportedPublishedBytes: count
      .max(MCP_OUTPUT_SYNC_LIMITS.publishedBytes)
      .nullable(),
    publicationUnconfirmed: count.max(352),
    errorCode: McpOutputSyncErrorCodeSchema.nullable(),
    metadata: z.enum([
      "pending",
      "partial",
      "published",
      "publication_unconfirmed",
    ]),
    mirror: z.enum(["pending", "published", "publication_unconfirmed"]),
  })
  .strict();
const McpOutputSyncEvidenceSchema = z
  .object({
    extent: z.literal("current-destination-files-only"),
    sourceChecked: z.literal(false),
    destination: z.enum(["matched", "unavailable"]),
    checkedAt: count,
    files: z
      .array(
        z
          .object({
            fileId: McpOutputSyncFileIdSchema,
            currentState: z.enum([
              "matches_planned",
              "matches_previous",
              "missing",
              "changed",
              "unavailable",
              "not_checked",
            ]),
            bytes: count.max(MCP_OUTPUT_SYNC_LIMITS.imageBytes).nullable(),
            sha256: sha256.nullable(),
          })
          .strict(),
      )
      .max(352),
  })
  .strict();
export const mcpOutputSyncInputs = {
  carrot_get_output_destination: McpGetOutputDestinationSchema,
  carrot_preflight_output_sync: McpPreflightOutputSyncSchema,
  carrot_sync_output: McpSyncOutputSchema,
  carrot_get_output_sync: McpGetOutputSyncSchema,
};
export const mcpOutputSyncOutputs = {
  carrot_get_output_destination: McpOutputDestinationSchema,
  carrot_preflight_output_sync: McpOutputSyncPreflightSchema,
  carrot_get_output_sync: z
    .object({
      receipt: McpOutputSyncReceiptSchema,
      evidence: McpOutputSyncEvidenceSchema.nullable(),
    })
    .strict(),
};
export type McpSyncOutput = z.infer<typeof McpSyncOutputSchema>;
export type McpOutputSyncPreflight = z.infer<
  typeof McpOutputSyncPreflightSchema
>;
export type McpOutputSyncFile = z.infer<typeof McpOutputSyncFileSchema>;
export type McpOutputSyncEffect = z.infer<typeof McpOutputSyncEffectSchema>;
export type McpOutputSyncResult = z.infer<typeof McpOutputSyncResultSchema>;
export type McpOutputSyncReceipt = z.infer<typeof McpOutputSyncReceiptSchema>;
