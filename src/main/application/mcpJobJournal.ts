import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";

const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative();
export const MCP_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const MCP_JOB_CAPACITY = 512;
export const mcpJobTargetSchema = z
  .object({
    chapterId: id,
    pageId: id,
    revision: z.string().regex(/^page-v1:[a-f0-9]{16}$/),
    requestId: z.string().uuid(),
  })
  .strict();
export type McpStoredJobTarget = z.infer<typeof mcpJobTargetSchema>;

const resultSchema = z.object({
  status: z.string().max(40).optional(),
  revision: z.string().max(64).optional(),
  chapterId: id.optional(),
  pageId: id.optional(),
  engine: z.string().max(128).optional(),
  performed: z.array(z.string().max(40)).max(16).optional(),
  blockIds: z.array(id).max(5000).optional(),
  width: count.optional(),
  height: count.optional(),
  bytes: count.optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  kind: z.string().max(64).optional(),
  pagesChanged: count.optional(),
  blocksErased: count.optional(),
  blocksIncomplete: count.optional(),
  noTextDetected: z.boolean().optional(),
  effectReviewCandidates: count.optional(),
  needsReview: z.boolean().optional(),
});
const jobSchema = z
  .object({
    id: z.string().uuid(),
    owner: id,
    requestId: id,
    kind: z.enum(["ocr", "erase", "exportPng"]),
    parameters: mcpJobTargetSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
    status: z.enum([
      "running",
      "completed",
      "partial",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    progress: z
      .object({
        phase: z.string().max(128),
        completed: count.optional(),
        total: count.optional(),
      })
      .strict(),
    result: resultSchema.optional(),
    error: z
      .object({ code: z.string().max(128), message: z.string().max(1024) })
      .strict()
      .optional(),
    startedAt: timestamp,
    finishedAt: timestamp.optional(),
    cancellationRequested: z.boolean(),
  })
  .strict();
export type McpStoredJob = z.infer<typeof jobSchema>;
export type McpJobPersistence = {
  load: () => Promise<unknown | null>;
  save: (snapshot: unknown) => Promise<void>;
};
const journalSchema = z
  .object({
    version: z.literal(1),
    records: z.array(jobSchema).max(MCP_JOB_CAPACITY),
  })
  .strict();

/** Only public receipts/targets are retained; capability URLs, images and raw errors are deliberately omitted. */
export function persistedMcpJobResult(
  result: Record<string, unknown> | undefined,
) {
  return result === undefined ? undefined : resultSchema.parse(result);
}
export function parseMcpJobJournal(value: unknown): McpStoredJob[] {
  const parsed = journalSchema.parse(value);
  const ids = new Set<string>();
  const requests = new Set<string>();
  for (const record of parsed.records) {
    const key = JSON.stringify([record.owner, record.requestId]);
    if (
      ids.has(record.id) ||
      requests.has(key) ||
      record.fingerprint !==
        hashStableValue([record.kind, record.parameters]) ||
      record.requestId !== record.parameters.requestId
    )
      throw new Error("Invalid duplicate or inconsistent MCP job journal.");
    ids.add(record.id);
    requests.add(key);
  }
  return parsed.records;
}
