import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpSyncOutputSchema,
  McpOutputSyncReceiptSchema,
  type McpSyncOutput,
  type McpOutputSyncReceipt,
} from "../../shared/mcpOutputSync";
import {
  McpOutputSyncJobResultSchema,
  type McpOutputSyncJobResult,
} from "../../shared/mcpOutputSyncJob";
import { McpEditError } from "./mcpEditPolicy";

type Job = {
  id?: string;
  kind: string;
  requestId: string;
  parameters: unknown;
  result?: unknown;
};
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function validMcpOutputSyncJobResult(value: unknown): boolean {
  const result = object(value);
  if (!result) return false;
  return result.kind === "output-sync"
    ? McpOutputSyncJobResultSchema.safeParse(result).success
    : result.outputSync === undefined;
}
export function validMcpOutputSyncJobReference(job: Job): boolean {
  const value = object(job.result);
  if (job.kind !== "outputSync")
    return (
      !value || (value.kind !== "output-sync" && value.outputSync === undefined)
    );
  const target = McpSyncOutputSchema.safeParse(job.parameters);
  if (!target.success || target.data.requestId !== job.requestId) return false;
  if (job.result === undefined) return true;
  const parsed = McpOutputSyncJobResultSchema.safeParse(job.result);
  if (!parsed.success) return false;
  return sameTarget(target.data, parsed.data.outputSync, job.id);
}
function sameTarget(
  input: McpSyncOutput,
  reference: McpOutputSyncJobResult["outputSync"],
  jobId: string | undefined,
) {
  return (
    reference.jobId === jobId &&
    reference.requestId === input.requestId &&
    reference.chapterId === input.chapterId &&
    reference.connectionId === input.connectionId &&
    reference.requestFingerprint === hashStableValue(input) &&
    reference.pageIds.length === input.pageIds.length &&
    reference.pageIds.every((id, index) => id === input.pageIds[index])
  );
}
/** Only the native receipt repository supplies the receipt. This projection does
 * not publish files, infer completion, inspect current destinations or reissue work. */
export function mcpOutputSyncJobResult(input: {
  input: McpSyncOutput;
  receipt: McpOutputSyncReceipt;
  jobId: string;
}): McpOutputSyncJobResult {
  const request = McpSyncOutputSchema.parse(input.input);
  const receipt = McpOutputSyncReceiptSchema.parse(input.receipt);
  const result = McpOutputSyncJobResultSchema.safeParse({
    kind: "output-sync",
    status: receipt.status,
    outputSync: {
      receiptId: receipt.id,
      requestId: receipt.requestId,
      jobId: receipt.jobId,
      chapterId: receipt.chapterId,
      connectionId: receipt.connectionId,
      pageIds: [...receipt.pageIds],
      requestFingerprint: hashStableValue(request),
      retention: "seven-days",
      availability: "lookup-required",
    },
  });
  if (
    !result.success ||
    !sameTarget(request, result.data.outputSync, input.jobId)
  )
    throw new McpEditError(
      "invalid_edit",
      "Output sync receipt does not match this completed operation and reviewed request.",
    );
  return result.data;
}
