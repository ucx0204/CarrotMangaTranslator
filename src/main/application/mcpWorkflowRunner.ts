import { randomUUID } from "node:crypto";
import { McpEditError } from "./mcpEditPolicy";
import { workflowError, type McpWorkflowRecord, type McpWorkflowStep, type McpWorkflowPage, type McpWorkflowOutcome } from "./mcpWorkflowPolicy";

export type McpWorkflowRuntime = {
  verify: (record: McpWorkflowRecord, changedPage?: number) => Promise<McpWorkflowPage | undefined>;
  cost: (record: McpWorkflowRecord, step: McpWorkflowStep) => Promise<number>;
  execute: (record: McpWorkflowRecord, step: McpWorkflowStep, signal: AbortSignal, onJob: (id: string) => Promise<void>) => Promise<McpWorkflowOutcome>;
  reconcile: (record: McpWorkflowRecord, step: McpWorkflowStep) => Promise<{ page: McpWorkflowPage; outcome: McpWorkflowOutcome } | undefined>;
};
export type McpWorkflowActive = {
  record: McpWorkflowRecord;
  controller: AbortController;
  pause: boolean;
  done: Promise<void>;
};
export type McpWorkflowRunnerPort = {
  save: (record: McpWorkflowRecord, version: number) => Promise<void>;
  open: (record: McpWorkflowRecord, guard: () => void) => Promise<McpWorkflowRuntime>;
  reportError: (error: unknown) => void;
  now: () => number;
};
export async function persistWorkflow(port: Pick<McpWorkflowRunnerPort, "save">, record: McpWorkflowRecord) {
  const previous = record.version;
  record.version++;
  await port.save(record, previous);
}
/** This orders app operations, not GPU leases. The native job/runtime retains ownership. */
export async function runMcpWorkflow(port: McpWorkflowRunnerPort, active: McpWorkflowActive, check: () => void, retryFailed: boolean) {
  const record = active.record;
  const guard = () => {
    active.controller.signal.throwIfAborted();
    check();
    if (record.expiresAt <= port.now())
      throw new McpEditError("not_found", "Workflow retention expired.");
  };
  try {
    guard();
    const runtime = await port.open(record, guard);
    await reconcileWorkflowAttempt(port, record, runtime, retryFailed);
    await runtime.verify(record);
    for (const step of record.steps) {
      if (step.status === "completed") continue;
      guard();
      if (active.pause) { record.status = "paused"; break; }
      if (step.stage === "await-external") {
        step.status = "waiting_external";
        record.status = "waiting_external";
        break;
      }
      if (!(await runStep(port, active, runtime, step, guard))) return;
    }
    if (record.steps.every((step) => step.status === "completed")) record.status = "completed";
    await persistWorkflow(port, record);
  } catch (error) {
    record.lastError = workflowError(error);
    record.status = active.controller.signal.aborted ? "cancelled" : "failed";
    await persistWorkflow(port, record);
    port.reportError(error);
  }
}
async function runStep(port: McpWorkflowRunnerPort, active: McpWorkflowActive, runtime: McpWorkflowRuntime, step: McpWorkflowStep, guard: () => void) {
  const record = active.record;
  await runtime.verify(record);
  const translationCost = await runtime.cost(record, step);
  if (record.pageAttemptsUsed >= record.input.maxPageAttempts ||
      record.translationRequestsReserved + translationCost > record.input.maxTranslationRequests)
    throw new McpEditError("invalid_edit", "Workflow attempt or translation-request budget is exhausted. No new model work started.");
  guard();
  step.status = "running";
  step.attemptId = randomUUID();
  step.attempts++;
  step.jobId = null;
  step.errorCode = null;
  record.pageAttemptsUsed++;
  record.translationRequestsReserved += translationCost;
  await persistWorkflow(port, record);
  try {
    const outcome = await runtime.execute(record, step, active.controller.signal, async (id) => {
      step.jobId = id;
      await persistWorkflow(port, record);
    });
    const page = await runtime.verify(record, step.pageIndex);
    if (!page || page.revision !== outcome.revision)
      throw new McpEditError("revision_conflict", "Saved step outcome does not match the current page.");
    completeStep(record, step, page, outcome);
    await persistWorkflow(port, record);
    return true;
  } catch (error) {
    const recovered = await runtime.reconcile(record, step);
    if (recovered) completeStep(record, step, recovered.page, recovered.outcome);
    else { step.status = "failed"; step.errorCode = workflowError(error); }
    record.lastError = workflowError(error);
    record.status = active.controller.signal.aborted ? "cancelled" : "failed";
    await persistWorkflow(port, record);
    port.reportError(error);
    return false;
  }
}
export async function reconcileWorkflowAttempt(port: Pick<McpWorkflowRunnerPort, "save">, record: McpWorkflowRecord, runtime: McpWorkflowRuntime, retryFailed: boolean) {
  for (const step of record.steps) {
    if (step.status !== "running" && step.status !== "failed") continue;
    const recovered = await runtime.reconcile(record, step);
    if (recovered) {
      completeStep(record, step, recovered.page, recovered.outcome);
      await persistWorkflow(port, record);
      continue;
    }
    if (!retryFailed)
      throw new McpEditError("invalid_edit", "An interrupted/failed attempt has no conclusive saved receipt. Inspect it and explicitly set retryFailed=true to permit another model request.");
    await runtime.verify(record);
    step.status = "pending";
    step.errorCode = null;
  }
}
function completeStep(record: McpWorkflowRecord, step: McpWorkflowStep, page: McpWorkflowPage, outcome: McpWorkflowOutcome) {
  record.pages[step.pageIndex] = page;
  step.status = "completed";
  step.outputId = outcome.outputId ?? null;
  step.changeId = outcome.changeId ?? null;
  step.errorCode = null;
  record.lastError = null;
}
