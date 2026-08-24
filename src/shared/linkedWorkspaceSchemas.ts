import { z } from "zod";

const RasterExportFormatSchema = z.enum(["source", "png", "jpeg", "webp"]);
const LinkedWorkspaceDestinationKindSchema = z.enum(["managed", "custom"]);

export const RasterExportSettingsSchema = z
  .object({
    format: RasterExportFormatSchema,
    jpegQuality: z.number().int().min(1).max(100),
    webpQuality: z.number().int().min(1).max(100),
    preserveSourceNames: z.boolean(),
    destinationMode: z.enum(["timestamped", "fixed"]),
    collisionPolicy: z.enum(["replace", "skip", "cancel"]),
  })
  .strict();

export const LinkedWorkspaceImportOptionsSchema = z
  .object({
    enabled: z.boolean(),
    outputFormat: RasterExportFormatSchema,
    jpegQuality: z.number().int().min(1).max(100),
    webpQuality: z.number().int().min(1).max(100),
  })
  .strict();

export const ConnectLinkedWorkspaceRequestSchema = z
  .object({
    workId: z.string().uuid(),
    chapterId: z.string().uuid(),
    output: RasterExportSettingsSchema,
    rootPath: z.string().min(1).max(4096).optional(),
    destinationKind: LinkedWorkspaceDestinationKindSchema.optional(),
    enqueueExistingPages: z.boolean().optional(),
  })
  .strict();

export const UpdateLinkedWorkspaceRequestSchema = z
  .object({
    connectionId: z.string().uuid(),
    enabled: z.boolean().optional(),
    output: RasterExportSettingsSchema.optional(),
  })
  .strict()
  .refine(
    (request) => request.enabled !== undefined || request.output !== undefined,
    "No linked workspace setting was provided.",
  );

export const ViewLinkedResultsRequestSchema = z
  .object({
    chapterId: z.string().uuid(),
    currentPageId: z.string().uuid().optional(),
  })
  .strict();

export const LinkedWorkspaceStatusSchema = z
  .object({
    chapterId: z.string().uuid(),
    connectionId: z.string().uuid().optional(),
    state: z.enum([
      "unlinked",
      "disabled",
      "idle",
      "pending",
      "syncing",
      "failed",
    ]),
    pendingCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    rootPath: z.string().min(1).max(4096).optional(),
    rootName: z.string().min(1).max(260).optional(),
    destinationKind: LinkedWorkspaceDestinationKindSchema.optional(),
    outputFormat: RasterExportFormatSchema.optional(),
    notice: z.string().max(4000).optional(),
    lastError: z.string().max(4000).optional(),
  })
  .strict();

export const LinkedWorkspaceActivityRequestSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("pulse") }).strict(),
    z
      .object({
        type: z.enum(["start", "end"]),
        interaction: z.enum(["pointer", "composition"]),
      })
      .strict(),
  ],
);
