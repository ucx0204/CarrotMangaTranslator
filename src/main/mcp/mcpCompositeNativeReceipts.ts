import { z } from "zod/v4";
import { McpEditError } from "../application/mcpEditPolicy";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import type {
  McpCompositeOutcome,
  McpCompositeSavedBinding,
} from "../application/mcpCompositeWorkflowPorts";
import type { McpCompositeChildReference } from "../../shared/mcpCompositeWorkflow";
import type { McpOperationService } from "../application/mcpOperationService";

export type CompositeNativeJob = ReturnType<McpOperationService["status"]>;
export const compositeNativeJobId = z.object({ jobId: z.uuid() });

export function compositeChildReference(
  binding: McpCompositeSavedBinding,
  kind: McpCompositeChildReference["kind"],
  id: string,
): McpCompositeChildReference {
  return {
    kind,
    id,
    requestId: binding.nativeRequestId,
    family: binding.family,
    inputFingerprint: binding.inputFingerprint,
  };
}

export function assertCompositeChildReference(
  binding: McpCompositeSavedBinding,
  receipt: McpCompositeChildReference,
) {
  if (
    receipt.family !== binding.family ||
    receipt.requestId !== binding.nativeRequestId ||
    receipt.inputFingerprint !== binding.inputFingerprint
  )
    throw new McpEditError(
      "invalid_edit",
      "Native child reference does not match its owned parent binding.",
    );
}

export function compositeNativeOutcome(
  receipt: McpCompositeChildReference,
  native: { status: string },
): McpCompositeOutcome {
  const statuses = [
    "completed",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ] as const;
  const status = statuses.find((value) => value === native.status) ?? "partial";
  return { receipt, status, resultFingerprint: compositeFingerprint(native) };
}

export function compositeNativeJobOutcome(
  binding: McpCompositeSavedBinding,
  job: CompositeNativeJob,
) {
  const receipt = compositeChildReference(binding, "job", job.jobId);
  const outcome = compositeNativeOutcome(receipt, job);
  if (job.status === "running") return null;
  if (
    job.status === "completed" &&
    (!job.result ||
      job.result.cleanupFailed ||
      (job.result.blocksIncomplete ?? 0) > 0)
  )
    outcome.status = "partial";
  return outcome;
}

export function assertNativeJobReference(
  binding: McpCompositeSavedBinding,
  job: CompositeNativeJob,
) {
  if (
    !binding.nativeReference ||
    job.requestId !== binding.nativeRequestId ||
    job.kind !== binding.nativeReference.kind
  )
    throw new McpEditError(
      "invalid_edit",
      "The native job receipt belongs to different input or family.",
    );
}
