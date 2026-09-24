import { z } from "zod/v4";
import {
  McpOutputSyncReceiptSchema,
  McpOutputSyncSnapshotSchema,
} from "./mcpOutputSync";

const receipt = McpOutputSyncReceiptSchema.shape;
/** A durable receipt lookup hint, never a downloadable artifact or native path. */
export const McpOutputSyncJobReferenceSchema = z
  .object({
    receiptId: receipt.id,
    requestId: receipt.requestId,
    jobId: receipt.jobId,
    chapterId: receipt.chapterId,
    connectionId: receipt.connectionId,
    pageIds: receipt.pageIds,
    requestFingerprint: McpOutputSyncSnapshotSchema,
    retention: z.literal("seven-days"),
    availability: z.literal("lookup-required"),
  })
  .strict();
export const McpOutputSyncJobResultSchema = z
  .object({
    kind: z.literal("output-sync"),
    status: receipt.status.exclude(["running"]),
    outputSync: McpOutputSyncJobReferenceSchema,
  })
  .strict();
export type McpOutputSyncJobResult = z.infer<
  typeof McpOutputSyncJobResultSchema
>;
