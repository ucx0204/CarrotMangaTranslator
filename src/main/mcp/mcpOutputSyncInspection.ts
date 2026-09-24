import type { McpOutputSyncOptions } from "./mcpOutputSyncTypes";
import { mcpOutputSyncOutputs } from "../../shared/mcpOutputSync";
import { McpOutputDeliveryMetadataSchema } from "../../shared/mcpOutputDelivery";

export async function inspectMcpOutputSync(
  options: McpOutputSyncOptions,
  owner: string,
  input: { id: string } | { requestId: string },
  guard: () => void,
) {
  const receipt = await options.repository.inspect(owner, input, guard);
  const privateEvidence = await options.repository.inspectEvidenceInput(
    owner,
    receipt.id,
    guard,
  );
  const evidence = options.port
    ? await options.port.inspectReceiptEvidence(privateEvidence, guard)
    : null;
  guard();
  return mcpOutputSyncOutputs.carrot_get_output_sync.parse({
    receipt,
    evidence,
  });
}

export async function diagnoseMcpOutputSync(
  options: McpOutputSyncOptions,
  owner: string,
  id: string,
  guard: () => void,
) {
  const { receipt, evidence } = await inspectMcpOutputSync(
    options,
    owner,
    { id },
    guard,
  );
  const current = new Map(
    evidence?.files.map((file) => [file.fileId, file.currentState]),
  );
  return McpOutputDeliveryMetadataSchema.parse({
    generation: { status: receipt.status, jobId: receipt.jobId },
    retention: {
      state: "retained",
      content: "not_checked",
      source: "not_checked",
      access: "allowed",
      checkedAt: Date.now(),
      expiresAt: receipt.expiresAt,
    },
    destinationPublication: {
      receiptId: receipt.id,
      status: receipt.status,
      publishedBytes: receipt.publishedBytes,
      metadata: receipt.metadata,
      mirror: receipt.mirror,
      files: receipt.files.map((file) => ({
        fileId: file.fileId,
        role: file.role,
        pageId: file.pageId,
        action: file.action,
        state: file.state,
        bytes: file.bytes,
        sha256: file.sha256,
        completedAt: file.completedAt,
        currentState: current.get(file.fileId) ?? "not_checked",
      })),
    },
  });
}
