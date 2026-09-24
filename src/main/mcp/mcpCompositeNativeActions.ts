import { z } from "zod/v4";
import { hashStableValue } from "../../shared/blockFingerprint";
import { mcpContextOutputSchemas } from "../../shared/mcpContextEditing";
import {
  McpTranslationBatchActionSchema,
  mcpTranslationBatchOutputs,
} from "../../shared/mcpTranslationBatch";
import type { McpWorkflowService } from "../application/mcpWorkflowService";
import type { McpResearchBatchService } from "../application/mcpResearchBatchService";
import type {
  McpCompositeBinding,
  McpCompositeSavedBinding,
  McpCompositeGuard,
  McpCompositeNative,
} from "../application/mcpCompositeWorkflowPorts";
import type { McpCompositeChildReference } from "../../shared/mcpCompositeWorkflow";
import { compositeFingerprint } from "../application/mcpCompositeWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  compositeNativeDispatch,
  compositeNativeFamily,
} from "./mcpCompositeNativeDispatch";
import {
  compositeChildReference,
  compositeNativeOutcome,
} from "./mcpCompositeNativeReceipts";
import { failAfterCompositeNativeCleanup } from "./mcpCompositeNativeCleanup";

type BatchFamily =
  | "selection-apply"
  | "typography-apply"
  | "lettering-apply"
  | "sfx-apply";
type BatchWait = (
  owner: string,
  id: string,
  requestId: string,
  signal: AbortSignal,
) => Promise<unknown>;
type Invoke = (
  name: string,
  input: Record<string, unknown>,
  owner: string,
  guard: McpCompositeGuard,
) => Promise<unknown>;
export type CompositeNativeActionOptions = {
  workflow?: McpWorkflowService["completion"];
  research?: McpResearchBatchService["completion"];
  batches: Partial<Record<BatchFamily, BatchWait>>;
};
const batchReads = {
  "selection-apply": "carrot_get_selection_batch",
  "typography-apply": "carrot_get_typography_batch",
  "lettering-apply": "carrot_get_lettering_batch",
  "sfx-apply": "carrot_get_sound_effect_batch",
};
const runId = z.object({ id: z.uuid() });
const batchSummary =
  mcpTranslationBatchOutputs.carrot_preview_translation_batch.strip();

/** Session plans and durable native runs keep their existing execution/undo owners. */
export class McpCompositeNativeActions {
  private readonly observations = new WeakMap<object, unknown>();
  constructor(
    private readonly options: CompositeNativeActionOptions,
    private readonly invoke: Invoke,
  ) {}
  observed(outcome: object) {
    return this.observations.get(outcome);
  }
  execute: McpCompositeNative["execute"] = async (
    binding,
    signal,
    onReceipt,
    guard,
  ) => {
    const mode = compositeNativeDispatch(binding.action).mode;
    if (mode === "workflow" || mode === "research")
      return this.run(binding, signal, onReceipt, guard);
    if (mode === "batch") return this.batch(binding, signal, onReceipt, guard);
    signal.throwIfAborted();
    const spec = compositeNativeDispatch(binding.action);
    const result = await this.invoke(
      spec.tool,
      binding.action.input,
      binding.owner,
      guard,
    );
    const receipt = immediateReceipt(binding, result);
    await onReceipt(receipt);
    guard();
    const outcome = {
      status: "completed" as const,
      receipt,
      resultFingerprint: compositeFingerprint(result),
    };
    this.observations.set(outcome, result);
    return outcome;
  };
  private async run(
    binding: McpCompositeBinding,
    signal: AbortSignal,
    onReceipt: (receipt: McpCompositeChildReference) => Promise<void>,
    guard: McpCompositeGuard,
  ) {
    const lease = this.runLease(binding);
    try {
      signal.throwIfAborted();
      const spec = compositeNativeDispatch(binding.action);
      const accepted = await this.invoke(
        spec.tool,
        binding.action.input,
        binding.owner,
        guard,
      );
      if (runId.parse(accepted).id !== lease.id) throw unavailable();
      const kind =
        binding.family === "workflow-run" ? "workflow" : "research-batch";
      const receipt = compositeChildReference(binding, kind, lease.id);
      await onReceipt(receipt);
      const result = await lease.wait(signal);
      guard();
      return compositeNativeOutcome(receipt, result);
    } catch (error) {
      return failAfterCompositeNativeCleanup(error, async () => {
        if (await lease.find()) await lease.wait(AbortSignal.abort(error));
      });
    }
  }
  private runLease(binding: McpCompositeBinding) {
    const action = binding.action;
    const native = binding.nativeReference;
    if (!native) throw unavailable();
    if (action.kind === "workflow-run" && this.options.workflow) {
      const completion = this.options.workflow;
      const reference = {
        id: action.input.id,
        requestId: native.requestId,
        fingerprint: native.fingerprint,
      };
      return {
        id: action.input.id,
        find: () => completion.find(binding.owner, reference),
        wait: (signal: AbortSignal) =>
          completion.wait(binding.owner, action.input, signal),
      };
    }
    if (action.kind === "research-run" && this.options.research) {
      const completion = this.options.research;
      const reference = {
        id: action.input.id,
        requestId: native.requestId,
        fingerprint: native.fingerprint,
      };
      return {
        id: action.input.id,
        find: () => completion.find(binding.owner, reference),
        wait: (signal: AbortSignal) =>
          completion.wait(binding.owner, action.input, signal),
      };
    }
    throw unavailable();
  }
  private async batch(
    binding: McpCompositeBinding,
    signal: AbortSignal,
    onReceipt: (receipt: McpCompositeChildReference) => Promise<void>,
    guard: McpCompositeGuard,
  ) {
    const input = McpTranslationBatchActionSchema.parse(binding.action.input);
    const wait = this.batchWait(binding.family);
    try {
      signal.throwIfAborted();
      const spec = compositeNativeDispatch(binding.action);
      const result = await this.invoke(spec.tool, input, binding.owner, guard);
      const accepted =
        mcpTranslationBatchOutputs.carrot_apply_translation_batch.parse(result);
      if (
        accepted.batchId !== input.batchId ||
        accepted.requestId !== input.requestId ||
        accepted.direction !== "apply"
      )
        throw unavailable();
      const receipt = compositeChildReference(binding, "batch", input.batchId);
      await onReceipt(receipt);
      const summary = batchSummary.parse(
        await wait(binding.owner, input.batchId, input.requestId, signal),
      );
      assertBatchRequest(summary, receipt);
      guard();
      return compositeNativeOutcome(receipt, summary);
    } catch (error) {
      return failAfterCompositeNativeCleanup(error, async () => {
        try {
          await wait(
            binding.owner,
            input.batchId,
            input.requestId,
            AbortSignal.abort(error),
          );
        } catch (cleanup) {
          if (
            !(cleanup instanceof McpEditError && cleanup.code === "not_found")
          )
            throw cleanup;
        }
      });
    }
  }
  private batchWait(family: McpCompositeSavedBinding["family"]) {
    if (!isBatchFamily(family)) throw unavailable();
    const wait = this.options.batches[family];
    if (!wait) throw unavailable();
    return wait;
  }
  reconcile: McpCompositeNative["reconcile"] = async (
    binding,
    receipt,
    guard,
  ) => {
    if (!receipt || !binding.nativeReference) return null;
    const mode = compositeNativeFamily(binding.family).mode;
    if (mode === "workflow" || mode === "research") {
      const completion =
        mode === "workflow" ? this.options.workflow : this.options.research;
      if (!completion) return null;
      const result = await completion.find(
        binding.owner,
        runReference(binding, receipt),
      );
      guard();
      return result && result.status !== "running"
        ? compositeNativeOutcome(receipt, result)
        : null;
    }
    if (mode !== "batch") return null;
    const family = binding.family;
    if (!isBatchFamily(family)) throw unavailable();
    assertBatchFingerprint(binding, receipt);
    const result = await this.invoke(
      batchReads[family],
      { batchId: receipt.id, offset: 0, limit: 1 },
      binding.owner,
      guard,
    );
    const summary = batchSummary.parse(result);
    assertBatchRequest(summary, receipt);
    guard();
    return summary.status === "running"
      ? null
      : compositeNativeOutcome(receipt, summary);
  };
  control: McpCompositeNative["control"] = async (
    binding,
    receipt,
    direction,
    guard,
  ) => {
    guard();
    const mode = compositeNativeFamily(binding.family).mode;
    if (mode === "workflow" || mode === "research") {
      const completion =
        mode === "workflow" ? this.options.workflow : this.options.research;
      if (!completion) throw unavailable();
      await completion.control(
        binding.owner,
        runReference(binding, receipt),
        direction,
      );
    } else if (mode === "batch" && direction === "cancel") {
      assertBatchFingerprint(binding, receipt);
      await this.batchWait(binding.family)(
        binding.owner,
        receipt.id,
        receipt.requestId,
        AbortSignal.abort(),
      );
    }
  };
}

function immediateReceipt(binding: McpCompositeBinding, result: unknown) {
  if (binding.action.kind === "context-apply") {
    const value =
      mcpContextOutputSchemas.carrot_apply_context_proposal.parse(result);
    if (
      value.proposalId !== binding.action.input.proposalId ||
      value.requestId !== binding.nativeRequestId ||
      compositeFingerprint(value.selectedChangeIds) !==
        compositeFingerprint(binding.action.input.selectedChangeIds)
    )
      throw unavailable();
    return compositeChildReference(binding, "context", value.proposalId);
  }
  if (binding.action.kind === "typography-prepare") {
    const value = batchSummary.parse(result);
    return compositeChildReference(binding, "batch", value.batchId);
  }
  throw unavailable();
}
function runReference(
  binding: McpCompositeSavedBinding,
  receipt: McpCompositeChildReference,
) {
  const expected =
    binding.family === "workflow-run" ? "workflow" : "research-batch";
  if (
    !binding.nativeReference ||
    receipt.kind !== expected ||
    binding.nativeReference.kind !== binding.family ||
    binding.nativeReference.requestId !== binding.nativeRequestId
  )
    throw unavailable();
  return {
    id: receipt.id,
    requestId: binding.nativeReference.requestId,
    fingerprint: binding.nativeReference.fingerprint,
  };
}
function assertBatchFingerprint(
  binding: McpCompositeSavedBinding,
  receipt: McpCompositeChildReference,
) {
  const input = { batchId: receipt.id, requestId: receipt.requestId };
  if (
    receipt.kind !== "batch" ||
    binding.nativeReference?.fingerprint !==
      hashStableValue([binding.family, input]) ||
    binding.inputFingerprint !== compositeFingerprint(input)
  )
    throw unavailable();
}
function assertBatchRequest(
  summary: ReturnType<typeof batchSummary.parse>,
  receipt: McpCompositeChildReference,
) {
  if (
    summary.batchId !== receipt.id ||
    summary.activeRequestId !== receipt.requestId ||
    summary.direction !== "apply"
  )
    throw unavailable();
}
function unavailable() {
  return new McpEditError(
    "not_found",
    "The exact native action or its owned completion handle is unavailable.",
  );
}

function isBatchFamily(family: string): family is BatchFamily {
  return Object.hasOwn(batchReads, family);
}
