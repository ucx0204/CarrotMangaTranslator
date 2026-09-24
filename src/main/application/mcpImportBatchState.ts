import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpImportBatchPrepareSchema,
  McpImportBatchRunSchema,
  McpImportBatchReferenceSchema,
} from "../../shared/mcpImportBatch";
import {
  McpImportPreviewReferenceSchema,
  McpImportReceiptSchema,
} from "../../shared/mcpLibraryImport";

const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{16}$/);
const target = z
  .object({
    id: z.uuid(),
    label: z.string().min(1).max(240),
    url: z.url().max(4096),
  })
  .strict();
const attempt = z
  .object({
    requestId: z.uuid(),
    status: z.enum(["scanning", "ready", "failed", "cancelled"]),
    preview: McpImportPreviewReferenceSchema.nullable(),
    errorCode: z.string().max(128).nullable(),
  })
  .strict()
  .refine(
    (value) => (value.status === "ready") === Boolean(value.preview),
    "Only completed scans have a frozen preview reference.",
  );
const row = z
  .object({
    target,
    attempts: z.array(attempt).max(30),
    receipt: McpImportReceiptSchema.nullable(),
  })
  .strict();
const shape = z
  .object({
    format: z.literal(1),
    id: z.uuid(),
    owner: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    version: count,
    input: McpImportBatchPrepareSchema,
    fingerprint: hash,
    sourceFingerprint: hash,
    createdAt: count,
    expiresAt: count,
    status: McpImportBatchReferenceSchema.shape.status,
    errorCode: z.string().max(128).nullable(),
    items: z.array(row).min(1).max(10),
    runs: z.array(McpImportBatchRunSchema).max(30),
  })
  .strict();
type RecordShape = z.infer<typeof shape>;
export const McpImportBatchRecordSchema = shape.refine(
  validRecord,
  "Inconsistent retained import preparation plan.",
);
export type McpImportBatchRecord = z.infer<typeof McpImportBatchRecordSchema>;
export type McpImportBatchRow = z.infer<typeof row>;

function validRecord(value: RecordShape): boolean {
  const targets = value.items.map((item) => item.target);
  const attempts = value.items.flatMap((item) => item.attempts);
  const runIds = value.runs.map((run) => run.requestId);
  const attemptIds = attempts.map((item) => item.requestId);
  return (
    value.fingerprint === hashStableValue(value.input) &&
    value.sourceFingerprint === hashStableValue(targets) &&
    targets.length === value.input.sources.length &&
    targets.every(
      (item, index) => item.label === value.input.sources[index].label,
    ) &&
    new Set(targets.map((item) => item.id)).size === targets.length &&
    new Set(targets.map((item) => item.url)).size === targets.length &&
    attempts.length <= value.input.maxAttempts &&
    new Set(attemptIds).size === attemptIds.length &&
    new Set(runIds).size === runIds.length &&
    value.runs.every(
      (run) => run.id === value.id && run.version < value.version,
    ) &&
    value.expiresAt > value.createdAt &&
    value.items.every((item) => validGroupedReceipt(value, item))
  );
}
/** A group is one publication: every member must retain the same receipt and its original preview. */
function validGroupedReceipt(
  value: RecordShape,
  item: McpImportBatchRow,
): boolean {
  const receipt = item.receipt;
  if (!receipt?.batch) return true;
  const mapping = receipt.batch.items;
  const chapters = mapping.flatMap((entry) => entry.chapterIds);
  if (
    receipt.batch.id !== value.id ||
    receipt.source !== "web" ||
    !mapping.some((entry) => entry.itemId === item.target.id) ||
    hashStableValue(chapters) !== hashStableValue(receipt.chapterIds) ||
    new Set(chapters).size !== chapters.length ||
    mapping.reduce((sum, entry) => sum + entry.pageCount, 0) !==
      receipt.pageCount ||
    new Set(mapping.map((entry) => entry.itemId)).size !== mapping.length ||
    new Set(mapping.map((entry) => entry.previewId)).size !== mapping.length
  )
    return false;
  return mapping.every((entry) => {
    const member = value.items.find(
      (candidate) => candidate.target.id === entry.itemId,
    );
    return Boolean(
      member &&
      hashStableValue(member.receipt) === hashStableValue(receipt) &&
      member.attempts.some(
        (candidate) => candidate.preview?.previewId === entry.previewId,
      ),
    );
  });
}

export function importBatchReference(record: McpImportBatchRecord) {
  return McpImportBatchReferenceSchema.parse({
    id: record.id,
    version: record.version,
    status: record.status,
    expiresAt: record.expiresAt,
    retention: "seven-days",
    availability: "lookup-required",
  });
}
