import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpExchangeFileArtifactSchema,
  mcpExchangeIdentity,
  type McpExchangeBinding,
} from "../../shared/mcpExchangeFiles";
import {
  McpTextExportTargetSchema,
  McpTextImportApplySchema,
  mcpTextExchangeOutputs,
} from "../../shared/mcpTextExchange";
import { McpContextExportSchema } from "../../shared/mcpContextExchange";
import { mcpTranslationBatchOutputs } from "../../shared/mcpTranslationBatch";

export const mcpExchangeJobTargets = {
  textFileExport: McpTextExportTargetSchema,
  contextFileExport: McpContextExportSchema,
  textFileImport: McpTextImportApplySchema,
};
export const mcpExchangeJobTargetSchema = z.union([
  McpTextExportTargetSchema,
  McpContextExportSchema,
  McpTextImportApplySchema,
]);

const artifact = McpExchangeFileArtifactSchema.shape;
export const mcpExchangeFileMetadataSchema = z
  .object({
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    retainedOutputId: artifact.retainedOutputId,
    exchange: artifact.exchange,
    performed: artifact.performed,
    artifactExpired: z.boolean().optional(),
  })
  .strict()
  .refine(
    (result) =>
      result.mimeType === mcpExchangeIdentity(result.exchange).mimeType,
    "Exchange MIME does not match its reviewed source.",
  );

const batch = mcpTranslationBatchOutputs.carrot_preview_translation_batch;
const terminal = z.enum(["completed", "partial", "failed", "cancelled"]);
const outcome = batch
  .extend({
    status: terminal,
    direction: z.literal("apply"),
    activeRequestId: z.uuid(),
    reason: z.string().max(2000),
    warnings: z.array(z.string().max(240)).max(60),
    pages: z
      .array(
        batch.shape.pages.element.extend({
          errorCode: z.string().max(128).nullable(),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();
const importResult = z
  .object({
    kind: z.literal("text-file-import"),
    batchId: z.uuid(),
    status: terminal,
    input: mcpTextExchangeOutputs.carrot_preview_text_file_import.shape.input,
    application: z.literal("page-by-page"),
    outcome,
    performed: z.tuple([z.literal("apply")]),
    completionCheck: z
      .object({
        status: z.literal("failed"),
        code: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (result) =>
      result.batchId === result.outcome.batchId &&
      (result.completionCheck
        ? result.status !== "completed"
        : result.status === result.outcome.status),
    "Import outcome does not match its completed action.",
  );

/** Only these new fields enter the general journal; their complete shape is
 * checked against the specific result kind below. Legacy projections stay stable. */
export const mcpExchangeResultFields = {
  mimeType: artifact.mimeType.optional(),
  exchange: artifact.exchange.optional(),
  batchId: importResult.shape.batchId.optional(),
  input: importResult.shape.input.optional(),
  application: importResult.shape.application.optional(),
  outcome: importResult.shape.outcome.optional(),
  completionCheck: importResult.shape.completionCheck,
};
const exchangeFields = new Set(Object.keys(mcpExchangeResultFields));
type RecordInput = {
  kind: string;
  requestId?: string;
  parameters?: unknown;
  result?: unknown;
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Raster, PSD, ZIP and native-file polling historically omitted MIME and these
 * unrelated fields. Adding an exchange receipt must not widen those projections. */
export function mcpExchangeMetadataInput(value: unknown): unknown {
  const result = object(value);
  if (
    !result ||
    ["exchange-file", "text-file-import"].includes(String(result.kind))
  )
    return value;
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => !exchangeFields.has(key)),
  );
}
export function validMcpExchangeResultMetadata(value: unknown): boolean {
  const result = object(value);
  if (!result) return false;
  if (result.kind === "exchange-file")
    return mcpExchangeFileMetadataSchema.safeParse(result).success;
  if (result.kind === "text-file-import")
    return importResult.safeParse(result).success;
  return [...exchangeFields].every((key) => result[key] === undefined);
}

/** The result is bound to the actual command and request, not merely to a
 * retained ID or a caller-provided file type. This policy also serves live reads. */
export function validMcpExchangeJobReferences(record: RecordInput): boolean {
  if (record.kind === "textFileImport") return validImportReference(record);
  const expected = exportBinding(record);
  if (expected) {
    if (record.result === undefined) return true;
    const parsed = mcpExchangeFileMetadataSchema
      .strip()
      .safeParse(record.result);
    return (
      parsed.success &&
      hashStableValue(parsed.data.exchange) === hashStableValue(expected)
    );
  }
  if (["textFileExport", "contextFileExport"].includes(record.kind))
    return false;
  const result = object(record.result);
  return (
    !result ||
    (result.exchange === undefined &&
      result.kind !== "exchange-file" &&
      result.kind !== "text-file-import")
  );
}
function exportBinding(record: RecordInput): McpExchangeBinding | undefined {
  if (record.kind === "textFileExport") {
    const target = McpTextExportTargetSchema.safeParse(record.parameters);
    return target.success && target.data.requestId === record.requestId
      ? target.data.binding
      : undefined;
  }
  if (record.kind !== "contextFileExport") return undefined;
  const target = McpContextExportSchema.safeParse(record.parameters);
  if (!target.success || target.data.requestId !== record.requestId)
    return undefined;
  const { workId, chapterId, scope, sourceSnapshot } = target.data;
  return {
    kind: "context",
    workId,
    chapterId,
    scope,
    snapshot: sourceSnapshot,
  };
}
function validImportReference(record: RecordInput): boolean {
  const target = McpTextImportApplySchema.safeParse(record.parameters);
  if (!target.success || target.data.requestId !== record.requestId)
    return false;
  if (record.result === undefined) return true;
  const parsed = importResult.strip().safeParse(record.result);
  return (
    parsed.success &&
    parsed.data.batchId === target.data.batchId &&
    parsed.data.outcome.activeRequestId === record.requestId
  );
}
