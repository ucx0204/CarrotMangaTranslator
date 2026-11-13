import { z } from "zod/v4";
import {
  mcpJobIdentitySchema,
  MCP_JOB_RETENTION_MS,
} from "../application/mcpJobJournal";

export const JOB_DETAIL_BYTES = 8 * 1024 * 1024;
export const JOB_CHUNK_BYTES = 512 * 1024;
export const JOB_CHUNK_FILE_BYTES = 1024 * 1024;
export const JOB_METADATA_BYTES = 64 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const jobRootSchema = z
  .object({
    version: z.literal(2),
    generation: z.uuid(),
    createdAt: count,
    legacy: z.object({ sha256: hash, expiresAt: count }).strict().optional(),
  })
  .strict();
export type JobRoot = z.infer<typeof jobRootSchema>;
const detailReferenceSchema = z
  .object({
    revision: z.uuid(),
    sha256: hash,
    bytes: count.min(1).max(JOB_DETAIL_BYTES),
  })
  .strict();
export type JobDetailReference = z.infer<typeof detailReferenceSchema>;
export const jobReceiptSchema = mcpJobIdentitySchema
  .extend({
    version: z.literal(2),
    generation: z.uuid(),
    revision: count.min(1),
    expiresAt: count.optional(),
    request: detailReferenceSchema,
    outcome: detailReferenceSchema,
  })
  .strict()
  .refine(
    (r) =>
      (r.status === "running") === (r.finishedAt === undefined) &&
      r.expiresAt ===
        (r.finishedAt === undefined
          ? undefined
          : r.finishedAt + MCP_JOB_RETENTION_MS),
    "Invalid job expiry or state.",
  );
export type JobReceipt = z.infer<typeof jobReceiptSchema>;
export const detailManifestSchema = z
  .object({
    bytes: count.min(1).max(JOB_DETAIL_BYTES),
    sha256: hash,
    chunks: z
      .array(
        z
          .object({ bytes: count.min(1).max(JOB_CHUNK_BYTES), sha256: hash })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export const chunkSchema = z
  .object({ data: z.string().max(Math.ceil(JOB_CHUNK_BYTES / 3) * 4) })
  .strict();
export type JobBinding = {
  generation: string;
  jobId: string;
  kind: "receipt" | "request" | "outcome";
  revision: string;
  part: string;
};
export type JobCodec = {
  seal: (binding: JobBinding, payload: unknown) => Promise<Buffer>;
  open: (binding: JobBinding, bytes: Buffer) => Promise<unknown>;
};
