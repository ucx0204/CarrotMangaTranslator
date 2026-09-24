import { z } from "zod/v4";
import { McpArtifactMimeSchema } from "./mcpOutputFormats";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const jobStatus = z.enum([
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);

const McpOutputDeliveryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("job"),
      jobId: z.string().uuid(),
      pageId: identifier.optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("retained-output"), outputId: z.string().uuid() })
    .strict(),
  z
    .object({ kind: z.literal("output-sync"), receiptId: z.string().uuid() })
    .strict(),
]);
export const McpGetOutputDeliverySchema = z
  .object({
    target: McpOutputDeliveryTargetSchema,
  })
  .strict();
export type McpOutputDeliveryTarget = z.infer<
  typeof McpOutputDeliveryTargetSchema
>;
export type McpGetOutputDelivery = z.infer<typeof McpGetOutputDeliverySchema>;

const publicationStatus = z.enum([
  "pending",
  "published",
  "partial",
  "publication_unconfirmed",
  "failed",
  "not_attempted",
]);
const syncFile = z
  .object({
    fileId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    role: z.enum(["result", "inpainted", "mask", "mirror", "registry"]),
    pageId: identifier.nullable().optional(),
    action: z.enum(["publish", "remove"]),
    state: z.enum([
      "planned",
      "publication_unconfirmed",
      "published",
      "removed",
      "failed",
      "skipped",
    ]),
    bytes: count.nullable().optional(),
    sha256: hash.nullable().optional(),
    completedAt: count.nullable().optional(),
    currentState: z
      .enum([
        "matches_planned",
        "matches_previous",
        "missing",
        "changed",
        "unavailable",
        "not_checked",
      ])
      .optional(),
  })
  .strict();

/** Safe projections only. Native paths, URLs, payload text and error strings are excluded. */
export const McpOutputDeliveryMetadataSchema = z
  .object({
    generation: z
      .object({
        status: jobStatus,
        jobId: z.string().uuid().optional(),
        finishedAt: count.optional(),
      })
      .strict(),
    artifact: z
      .object({
        mimeType: McpArtifactMimeSchema,
        bytes: count,
        sha256: hash,
        retainedOutputId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    retention: z
      .object({
        state: z.enum([
          "retained",
          "expired",
          "unavailable",
          "not_retained",
          "not_applicable",
          "unknown",
        ]),
        content: z.enum(["verified", "mismatch", "not_checked"]),
        source: z.enum(["current", "stale", "not_checked"]),
        access: z.enum(["allowed", "blocked", "not_checked"]),
        checkedAt: count.optional(),
        expiresAt: count.optional(),
      })
      .strict(),
    sessionFile: z
      .object({
        state: z.enum(["available", "expired", "unavailable", "not_checked"]),
        checkedAt: count.optional(),
      })
      .strict()
      .optional(),
    destinationPublication: z
      .object({
        receiptId: z.string().uuid(),
        connectionId: z.string().uuid().optional(),
        status: jobStatus,
        publishedBytes: count,
        metadata: publicationStatus,
        mirror: publicationStatus,
        files: z.array(syncFile).max(512),
      })
      .strict()
      .optional(),
  })
  .strict();
export type McpOutputDeliveryMetadata = z.infer<
  typeof McpOutputDeliveryMetadataSchema
>;

const McpOutputDeliveryHttpEventSchema = z
  .object({
    method: z.enum(["GET", "HEAD"]),
    state: z.enum(["started", "completed", "interrupted", "failed"]),
    startedAt: count,
    finishedAt: count.optional(),
    bytesQueued: count,
  })
  .strict();
export type McpOutputDeliveryHttpEvent = z.infer<
  typeof McpOutputDeliveryHttpEventSchema
>;

const observed = z
  .object({
    state: z.literal("observed"),
    checkedAt: count,
    firstObservedAt: count,
    lastObservedAt: count,
    historyComplete: z.literal(false),
    capabilities: z
      .object({
        generated: count,
        reissued: count,
        latestCreatedAt: count,
        latestExpiresAt: count,
      })
      .strict(),
    toolResponsesPrepared: z
      .object({
        text: count,
        attachment: count,
        lastPreparedAt: count.optional(),
      })
      .strict(),
    http: z
      .object({
        getStarted: count,
        headStarted: count,
        getCompleted: count,
        headCompleted: count,
        interrupted: count,
        failed: count,
        inFlight: count,
        bytesQueued: count,
      })
      .strict(),
    countsSaturated: z.boolean(),
    recentEventsTruncated: z.boolean(),
    recentEvents: z.array(McpOutputDeliveryHttpEventSchema).max(8),
  })
  .strict();
export const McpOutputDeliveryObservationSchema = z.discriminatedUnion(
  "state",
  [
    observed,
    z
      .object({
        state: z.literal("not_observed"),
        checkedAt: count,
        historyComplete: z.literal(false),
      })
      .strict(),
  ],
);
export type McpOutputDeliveryObservation = z.infer<
  typeof McpOutputDeliveryObservationSchema
>;
export type McpObservedOutputDelivery = z.infer<typeof observed>;

export const McpOutputDeliveryReportSchema =
  McpOutputDeliveryMetadataSchema.extend({
    target: McpOutputDeliveryTargetSchema,
    checkedAt: count,
    observation: McpOutputDeliveryObservationSchema,
    clientReceipt: z.literal("unconfirmed"),
  }).strict();
export type McpOutputDeliveryReport = z.infer<
  typeof McpOutputDeliveryReportSchema
>;
export const mcpOutputDeliveryOutputs = {
  carrot_get_output_delivery: McpOutputDeliveryReportSchema,
};
