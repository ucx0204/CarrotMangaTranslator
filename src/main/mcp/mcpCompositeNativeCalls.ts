import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { McpCompositeWorkflowActionSchema } from "../../shared/mcpCompositeWorkflowActions";
import { McpEditError } from "../application/mcpEditPolicy";
import type { McpOperationService } from "../application/mcpOperationService";
import type {
  McpCompositeBinding,
  McpCompositeSavedBinding,
  McpCompositeGuard,
  McpCompositeNative,
} from "../application/mcpCompositeWorkflowPorts";
import type { McpCompositeChildReference } from "../../shared/mcpCompositeWorkflow";
import type { McpTool } from "./mcpReadTools";
import { invokeMcpCompositeNativeTool } from "./mcpCompositeNativeTools";
import {
  compositeNativeDispatch,
  compositeNativeFamily,
  compositeNativeReference,
} from "./mcpCompositeNativeDispatch";
import {
  assertCompositeChildReference,
  assertNativeJobReference,
  compositeChildReference,
  compositeNativeJobId,
  compositeNativeJobOutcome,
  type CompositeNativeJob,
} from "./mcpCompositeNativeReceipts";
import {
  McpCompositeNativeActions,
  type CompositeNativeActionOptions,
} from "./mcpCompositeNativeActions";
import { failAfterCompositeNativeCleanup } from "./mcpCompositeNativeCleanup";

type OnReceipt = (receipt: McpCompositeChildReference) => Promise<void>;
export type CompositeNativeCallOptions = CompositeNativeActionOptions & {
  /** The same already-registered, retention-wrapped tool objects exposed by this session. */
  tools: readonly McpTool[];
  operations: McpOperationService;
};

/** Calls a closed native family and keeps its physical completion lease until settlement. */
export class McpCompositeNativeCalls {
  private readonly actions: McpCompositeNativeActions;
  constructor(private readonly options: CompositeNativeCallOptions) {
    this.actions = new McpCompositeNativeActions(
      options,
      this.invoke.bind(this),
    );
  }
  observed(outcome: object) {
    return this.actions.observed(outcome);
  }
  private async invoke(
    name: string,
    input: Record<string, unknown>,
    owner: string,
    guard: McpCompositeGuard,
  ) {
    return (
      await invokeMcpCompositeNativeTool(
        this.options.tools,
        name,
        input,
        owner,
        guard,
      )
    ).structuredContent;
  }
  execute: McpCompositeNative["execute"] = async (
    binding,
    signal,
    onReceipt,
    guard,
  ) => {
    assertNativeBinding(binding);
    if (compositeNativeDispatch(binding.action).mode !== "job")
      return this.actions.execute(binding, signal, onReceipt, guard);
    return this.job(binding, signal, onReceipt, guard);
  };
  private async job(
    binding: McpCompositeBinding,
    signal: AbortSignal,
    onReceipt: OnReceipt,
    guard: McpCompositeGuard,
  ) {
    let owned: CompositeNativeJob | undefined;
    try {
      signal.throwIfAborted();
      const spec = compositeNativeDispatch(binding.action);
      const accepted = await this.invoke(
        spec.tool,
        binding.action.input,
        binding.owner,
        guard,
      );
      owned = await this.findJob(binding);
      if (!owned || compositeNativeJobId.parse(accepted).jobId !== owned.jobId)
        throw new McpEditError(
          "invalid_edit",
          "Native admission did not return its exact owned receipt.",
        );
      await onReceipt(compositeChildReference(binding, "job", owned.jobId));
      const settled = await this.options.operations.waitForCompletion(
        owned.jobId,
        binding.owner,
        signal,
      );
      guard();
      const outcome = compositeNativeJobOutcome(binding, settled);
      if (!outcome)
        throw new Error("Native completion returned an unsettled job.");
      return outcome;
    } catch (error) {
      // Invocation/output validation can fail after admission. Resolve the exact native hash before cancelling.
      return failAfterCompositeNativeCleanup(error, async () => {
        owned ??= await this.findJob(binding);
        if (owned)
          await this.options.operations.waitForCompletion(
            owned.jobId,
            binding.owner,
            AbortSignal.abort(error),
          );
      });
    }
  }
  async findJob(binding: McpCompositeSavedBinding) {
    if (!binding.nativeReference) return undefined;
    const job = await this.options.operations.findOwnedOperation(
      binding.owner,
      binding.nativeReference,
    );
    if (job) assertNativeJobReference(binding, job);
    return job;
  }
  reconcile: McpCompositeNative["reconcile"] = async (
    binding,
    receipt,
    guard,
  ) => {
    guard();
    if (receipt) assertCompositeChildReference(binding, receipt);
    if (compositeNativeFamily(binding.family).mode !== "job")
      return this.actions.reconcile(binding, receipt, guard);
    const job = await this.findJob(binding);
    guard();
    if (!job) return null;
    if (receipt && (receipt.kind !== "job" || receipt.id !== job.jobId))
      throw new McpEditError(
        "invalid_edit",
        "The saved job reference does not match the native journal.",
      );
    if (expiredNativeObservation(job)) return null;
    return compositeNativeJobOutcome(binding, job);
  };
  control: McpCompositeNative["control"] = async (
    binding,
    receipt,
    direction,
    guard,
  ) => {
    guard();
    assertCompositeChildReference(binding, receipt);
    if (compositeNativeFamily(binding.family).mode !== "job")
      return this.actions.control(binding, receipt, direction, guard);
    const job = await this.findJob(binding);
    if (!job || receipt.kind !== "job" || receipt.id !== job.jobId)
      throw new McpEditError(
        "not_found",
        "Exact owned native job is unavailable.",
      );
    if (direction === "cancel")
      await this.options.operations.waitForCompletion(
        job.jobId,
        binding.owner,
        AbortSignal.abort(),
      );
  };
}
function expiredNativeObservation(job: CompositeNativeJob) {
  return (
    job.result?.observationExpired ||
    job.result?.proposalExpired ||
    job.result?.importPreviewExpired
  );
}

function assertNativeBinding(binding: McpCompositeBinding) {
  const action = McpCompositeWorkflowActionSchema.parse(binding.action);
  if (
    binding.family !== action.kind ||
    binding.nativeRequestId !== action.input.requestId ||
    binding.inputFingerprint !== compositeFingerprint(action.input) ||
    compositeFingerprint(binding.nativeReference) !==
      compositeFingerprint(compositeNativeReference(action))
  )
    throw new McpEditError(
      "invalid_edit",
      "Native action changed after its trusted binding.",
    );
}
