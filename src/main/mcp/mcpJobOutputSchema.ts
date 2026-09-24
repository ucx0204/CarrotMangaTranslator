import { z } from "zod/v4";
import { McpPageExportOptionsSchema } from "../../shared/mcpOutputFormats";
import { McpWorkFileExportArtifactSchema } from "../../shared/mcpWorkFileExport";
import { McpExchangeFileArtifactSchema } from "../../shared/mcpExchangeFiles";
import { validMcpOutputSyncJobReference } from "../application/mcpOutputSyncJobPolicy";
import {
  mcpJobResultMetadataSchema,
  mcpPersistedTargetSchema,
} from "../application/mcpJobJournal";

const text = z.string();
const count = z.number().int().nonnegative();
const flag = z.boolean();

/** Existing public job projection; the registry composes it without widening stored or public fields. */
export const mcpJobReceiptOutput = z
  .object({
    target: mcpPersistedTargetSchema.optional(),
    persistence: z.enum(["durable", "memory"]),
    jobId: text.uuid(),
    requestId: text,
    kind: text,
    status: z.enum([
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    cancellationRequested: z.boolean(),
    progress: z
      .object({
        phase: text,
        completed: count.optional(),
        total: count.optional(),
      })
      .strict(),
    result: mcpJobResultMetadataSchema.strict().optional(),
    error: z.object({ code: text, message: text }).strict().optional(),
    startedAt: count,
    finishedAt: count.optional(),
  })
  .strict()
  .refine(
    (receipt) =>
      validMcpOutputSyncJobReference({
        id: receipt.jobId,
        kind: receipt.kind,
        requestId: receipt.requestId,
        parameters: receipt.target,
        result: receipt.result,
      }),
    "Output sync job receipt does not match its target and durable reference.",
  );

const artifact = {
  retainedOutputId: text.uuid().optional(),
  jobId: text.uuid(),
  url: text.url(),
  bytes: count,
  sha256: text,
  expiresAt: count,
  access: text,
};

export const mcpJobFileOutput = z.discriminatedUnion("kind", [
  z
    .object({
      ...artifact,
      kind: z.literal("rendered-page-image"),
      mimeType: z.enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/vnd.adobe.photoshop",
      ]),
      imageExport: McpPageExportOptionsSchema,
    })
    .passthrough(),
  z
    .object({
      ...artifact,
      kind: z.literal("rendered-page-png"),
      mimeType: z.literal("image/png"),
    })
    .passthrough(),
  z
    .object({
      ...artifact,
      kind: z.literal("rendered-pages-zip"),
      mimeType: z.literal("application/zip"),
      filename: z.literal("carrot-pages.zip"),
      sourceJobId: text.uuid(),
      pageCount: count,
      partialOutput: flag,
    })
    .passthrough(),
  McpWorkFileExportArtifactSchema.extend({ jobId: text.uuid() }).strict(),
  z
    .object({ ...McpExchangeFileArtifactSchema.shape, jobId: text.uuid() })
    .strict()
    .refine(
      ({ jobId: _jobId, ...value }) =>
        McpExchangeFileArtifactSchema.safeParse(value).success,
      "Exchange file identity does not match its reviewed source.",
    ),
]);
