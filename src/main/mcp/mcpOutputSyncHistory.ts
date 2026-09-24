import { hashStableValue } from "../../shared/blockFingerprint";
import type {
  McpSyncOutput,
  McpOutputSyncReceipt,
} from "../../shared/mcpOutputSync";
import { mcpOutputSyncJobResult } from "../application/mcpOutputSyncJobPolicy";
import type { McpOperationService } from "../application/mcpOperationService";
import { McpEditError } from "../application/mcpEditPolicy";
import { mcpJobReceiptOutput } from "./mcpJobOutputSchema";

/** History always retains its original job identity and cannot start another job. */
export async function outputSyncHistoricalJob(
  operations: McpOperationService,
  owner: string,
  input: McpSyncOutput,
  receipt: McpOutputSyncReceipt,
  guard: () => void,
) {
  await operations.ready();
  guard();
  try {
    const job = operations.status(receipt.jobId, owner);
    if (
      job.kind !== "outputSync" ||
      job.requestId !== input.requestId ||
      hashStableValue(job.target) !== hashStableValue(input)
    )
      throw new McpEditError(
        "invalid_edit",
        "Retained output sync and job history disagree.",
      );
    return mcpJobReceiptOutput.parse(job);
  } catch (error) {
    if (!(error instanceof McpEditError) || error.code !== "not_found")
      throw error;
  }
  guard();
  return mcpJobReceiptOutput.parse({
    jobId: receipt.jobId,
    requestId: receipt.requestId,
    kind: "outputSync",
    status: receipt.status,
    cancellationRequested: receipt.status === "cancelled",
    progress: { phase: "retained_receipt" },
    ...(receipt.status === "running"
      ? {}
      : {
          result: mcpOutputSyncJobResult({
            input,
            receipt,
            jobId: receipt.jobId,
          }),
        }),
    startedAt: receipt.createdAt,
    target: input,
    persistence: "durable",
  });
}
