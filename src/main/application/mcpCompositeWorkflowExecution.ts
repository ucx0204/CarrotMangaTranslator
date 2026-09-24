import type { McpCompositeGuard } from "./mcpCompositeWorkflowPorts";
import { randomUUID } from "node:crypto";
import type {
  McpCompositeBinding,
  McpCompositeNative,
  McpCompositeOutcome,
  McpCompositeRecord,
  McpCompositeRepository,
  McpCompositeSettlement,
} from "./mcpCompositeWorkflowPorts";
import {
  assertCompositeOutcome,
  applyCompositeImport,
  assertCompositeSnapshot,
  compositeError,
  compositeFingerprint,
  nextCompositePhase,
  reserveCompositeCost,
} from "./mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "./mcpCompositeWorkflowRecord";

export async function reserveCompositeAttempt(
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  binding: McpCompositeBinding,
  requestId: string,
  guard: McpCompositeGuard,
) {
  const phase = nextCompositePhase(record);
  if (!phase || phase.status !== "bound" || phase.id !== binding.phaseId)
    compositeError("Bind the phase before running it.");
  reserveCompositeCost(record, binding.cost);
  phase.attemptId = randomUUID();
  phase.status = "running";
  record.status = "running";
  const version = record.version;
  record.version += 1;
  record.updatedAt = Date.now();
  // requestId is already durably journaled in the same candidate by the service.
  if (!record.actions.some((action) => action.requestId === requestId))
    compositeError("Admission requires a parent action receipt.");
  guard();
  return repository.reserve(parseCompositeRecord(record), version, guard);
}
export async function executeCompositeAttempt(
  native: McpCompositeNative,
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  binding: McpCompositeBinding,
  settlement: McpCompositeSettlement,
  signal: AbortSignal,
  guard: McpCompositeGuard,
) {
  let outcome: McpCompositeOutcome;
  try {
    outcome = await native.execute(
      binding,
      signal,
      async (receipt) => {
        assertCompositeOutcome(binding, {
          status: "interrupted",
          receipt,
          resultFingerprint: "0".repeat(64),
        });
        await settlement.checkpointChild(receipt);
      },
      guard,
    );
    assertCompositeOutcome(binding, outcome);
    await settlement.finish(outcome);
  } catch (error) {
    // The native port contract guarantees physical settlement even on failed checkpoint.
    try {
      await settlement.hold("checkpoint-failed");
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        "Native cleanup settled but parent checkpoint is unavailable.",
        { cause: settlementError },
      );
    }
    throw error;
  }
  if (signal.aborted || outcome.status !== "completed") return;
  const latest = await repository.load(record.owner, record.id);
  const completionGuard: McpCompositeGuard = (scopes) => {
    signal.throwIfAborted();
    guard(scopes);
  };
  try {
    await completeCompositeOutcome(
      native,
      repository,
      latest,
      outcome,
      completionGuard,
    );
  } catch (error) {
    if (error !== signal.reason) throw error;
  }
}
export async function completeCompositeOutcome(
  native: McpCompositeNative,
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  outcome: McpCompositeOutcome,
  guard: McpCompositeGuard,
) {
  guard();
  const phase = nextCompositePhase(record);
  if (!phase?.binding)
    compositeError("There is no exact bound native phase to reconcile.");
  assertCompositeOutcome(phase.binding, outcome);
  if (
    phase.child &&
    compositeFingerprint(phase.child) !== compositeFingerprint(outcome.receipt)
  )
    compositeError("Settlement cannot substitute another child identity.");
  phase.child = outcome.receipt;
  phase.outcome = outcome;
  if (record.status === "cancelled") {
    phase.status = "held";
    return saveCompositeRecord(repository, record, guard);
  }
  if (outcome.status !== "completed") {
    phase.status = "held";
    record.status = "held";
    record.stopReason = "native-outcome";
    return saveCompositeRecord(repository, record, guard);
  }
  applyCompositeImport(record, outcome);
  const snapshot = await native.refresh(record, outcome, guard);
  assertCompositeSnapshot(record, snapshot);
  guard();
  record.snapshot = snapshot;
  phase.status = "completed";
  record.status = nextCompositePhase(record) ? "prepared" : "completed";
  delete record.stopReason;
  return saveCompositeRecord(repository, record, guard);
}
export async function saveCompositeRecord(
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  guard: McpCompositeGuard,
) {
  const version = record.version;
  record.version += 1;
  record.updatedAt = Date.now();
  guard();
  return repository.save(parseCompositeRecord(record), version, guard);
}
