import type { McpCompositeImportPreflight } from "../../shared/mcpCompositeWorkflow";
import { McpCompositeWorkflowActionSchema } from "../../shared/mcpCompositeWorkflowActions";
import type {
  McpCompositeBinding,
  McpCompositeGuard,
  McpCompositeNative,
  McpCompositeOutcome,
  McpCompositeRecord,
} from "../application/mcpCompositeWorkflowPorts";
import {
  compositeFingerprint,
  nextCompositePhase,
} from "../application/mcpCompositeWorkflowPolicy";
import { McpEditError } from "../application/mcpEditPolicy";
import { McpCompositeNativeCalls } from "./mcpCompositeNativeCalls";
import {
  readMcpCompositeSources,
  type McpCompositeSourceOptions,
} from "./mcpCompositeNativePages";
import { compositeNativeReference } from "./mcpCompositeNativeDispatch";
import {
  compositeNativeRequirements,
  resolveCompositeNativeAction,
  type CompositeContextAnchor,
  type CompositeNativeOptions,
} from "./mcpCompositeNativeResolve";
import { preflightCompositeImport } from "./mcpCompositeNativeContext";
import { verifyCompositeNativeResult } from "./mcpCompositeNativeResults";
import { verifyCompositeNativeRefresh } from "./mcpCompositeNativeRefresh";
import { scopeError } from "./mcpCompositeNativeScope";

type Bound = { record: McpCompositeRecord; context?: CompositeContextAnchor };
/** Session-only concrete action authority. Persisted bindings cannot manufacture an admission. */
export class McpCompositeNativeResolver {
  readonly sources: McpCompositeSourceOptions;
  private bindings = new WeakMap<McpCompositeBinding, Bound>();
  private completed = new WeakMap<
    McpCompositeOutcome,
    { anchor: CompositeContextAnchor; result: unknown }
  >();
  private stopped = false;
  constructor(
    private readonly options: CompositeNativeOptions,
    private readonly calls: McpCompositeNativeCalls,
  ) {
    this.sources = {
      ...options,
      requirements: (plan) => compositeNativeRequirements(options, plan),
    };
  }
  prepare: McpCompositeNative["prepare"] = async (_owner, plan, guard) => {
    this.check(guard);
    const targets = plan.targets.kind === "saved" ? plan.targets.pages : [];
    const current = await readMcpCompositeSources(
      targets,
      plan,
      guard,
      this.sources,
    );
    this.check(guard);
    return current.snapshot;
  };
  resolve: McpCompositeNative["resolve"] = async (record, input, guard) => {
    this.check(guard);
    const action = McpCompositeWorkflowActionSchema.parse(input.action);
    const phase = record.plan.phases.find((item) => item.id === input.phaseId);
    if (
      phase?.kind !== "native" ||
      phase.action !== action.kind ||
      input.expectedSnapshot !== record.snapshot.fingerprint
    )
      throw scopeError();
    const current = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    if (current.snapshot.fingerprint !== record.snapshot.fingerprint)
      throw scopeError();
    const resolved = await resolveCompositeNativeAction(
      this.options,
      record,
      action,
      input.phaseId,
      current,
      guard,
    );
    this.check(guard);
    const binding: McpCompositeBinding = {
      owner: record.owner,
      compositeId: record.id,
      phaseId: input.phaseId,
      action,
      family: action.kind,
      inputFingerprint: compositeFingerprint(action.input),
      nativeRequestId: action.input.requestId,
      nativeReference: compositeNativeReference(action),
      snapshot: current.snapshot,
      predecessorReceipts: structuredClone(input.predecessorReceipts),
      cost: resolved.cost,
    };
    this.bindings.set(binding, {
      record: structuredClone(record),
      context: resolved.context,
    });
    return binding;
  };
  verify: McpCompositeNative["verify"] = async (binding, guard) => {
    this.check(guard);
    const bound = this.bindings.get(binding);
    if (!bound) throw unavailableBinding();
    const current = await readMcpCompositeSources(
      bound.record.targets,
      bound.record.plan,
      guard,
      this.sources,
    );
    if (current.snapshot.fingerprint !== binding.snapshot.fingerprint)
      throw scopeError();
    const resolved = await resolveCompositeNativeAction(
      this.options,
      bound.record,
      binding.action,
      binding.phaseId,
      current,
      guard,
    );
    if (
      compositeFingerprint(resolved.cost) !==
        compositeFingerprint(binding.cost) ||
      compositeFingerprint(resolved.context ?? null) !==
        compositeFingerprint(bound.context ?? null)
    )
      throw scopeError();
    this.check(guard);
  };
  execute: McpCompositeNative["execute"] = async (
    binding,
    signal,
    onReceipt,
    guard,
  ) => {
    const check: McpCompositeGuard = (scopes) => {
      signal.throwIfAborted();
      this.check(guard, scopes);
    };
    await this.verify(binding, check);
    const outcome = await this.calls.execute(binding, signal, onReceipt, guard);
    const verified = await verifyCompositeNativeResult(
      this.options,
      this.calls,
      binding,
      outcome,
      guard,
    );
    const context = this.bindings.get(binding)?.context;
    if (context)
      this.completed.set(verified, {
        anchor: context,
        result: this.calls.observed(outcome),
      });
    this.bindings.delete(binding);
    return verified;
  };
  reconcile: McpCompositeNative["reconcile"] = async (
    binding,
    receipt,
    guard,
  ) => {
    this.check(guard);
    try {
      const outcome = await this.calls.reconcile(binding, receipt, guard);
      if (!outcome) return null;
      return await verifyCompositeNativeResult(
        this.options,
        this.calls,
        binding,
        outcome,
        guard,
      );
    } catch (error) {
      if (error instanceof McpEditError && error.code === "not_found")
        return null;
      throw error;
    }
  };
  refresh: McpCompositeNative["refresh"] = async (record, outcome, guard) => {
    this.check(guard);
    const binding = completedBinding(record, outcome);
    const verified = await verifyCompositeNativeResult(
      this.options,
      this.calls,
      binding,
      outcome,
      guard,
    );
    if (
      verified.status !== "completed" ||
      compositeFingerprint(verified.imported ?? null) !==
        compositeFingerprint(outcome.imported ?? null)
    )
      throw scopeError();
    const current = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    await verifyCompositeNativeRefresh(
      this.options,
      this.calls,
      record,
      binding,
      outcome,
      current,
      guard,
      this.completed.get(outcome),
    );
    this.check(guard);
    this.completed.delete(outcome);
    return current.snapshot;
  };
  async importPreflight(
    owner: string,
    input: McpCompositeImportPreflight,
    guard: McpCompositeGuard,
  ) {
    this.check(guard);
    const result = await preflightCompositeImport(
      this.options,
      owner,
      input,
      guard,
    );
    this.check(guard);
    return result;
  }
  async verifySnapshot(record: McpCompositeRecord, guard: McpCompositeGuard) {
    this.check(guard);
    const current = await readMcpCompositeSources(
      record.targets,
      record.plan,
      guard,
      this.sources,
    );
    if (current.snapshot.fingerprint !== record.snapshot.fingerprint)
      throw scopeError();
    this.check(guard);
  }
  close() {
    this.stopped = true;
    this.bindings = new WeakMap();
    this.completed = new WeakMap();
  }
  private check(guard: McpCompositeGuard, scopes?: readonly string[]) {
    if (this.stopped) throw unavailableBinding();
    guard(scopes);
  }
}
function unavailableBinding() {
  return new McpEditError(
    "not_found",
    "Rebind the exact phase in this active native session before admission.",
  );
}
function completedBinding(
  record: McpCompositeRecord,
  outcome: McpCompositeOutcome,
) {
  const binding = nextCompositePhase(record)?.binding;
  if (
    !binding ||
    binding.owner !== record.owner ||
    binding.compositeId !== record.id ||
    outcome.status !== "completed" ||
    outcome.receipt.family !== binding.family ||
    outcome.receipt.requestId !== binding.nativeRequestId ||
    outcome.receipt.inputFingerprint !== binding.inputFingerprint
  )
    throw scopeError();
  return binding;
}
