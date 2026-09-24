import type { McpCompositeGuard } from "./mcpCompositeWorkflowPorts";
import type {
  McpCompositeNative,
  McpCompositeRecord,
  McpCompositeRepository,
} from "./mcpCompositeWorkflowPorts";
import {
  compositeError,
  nextCompositePhase,
  reserveCompositeCost,
  zeroCompositeCost,
} from "./mcpCompositeWorkflowPolicy";
import { assertCompositeEvidence } from "./mcpCompositeWorkflowReviewPolicy";
import { saveCompositeRecord } from "./mcpCompositeWorkflowExecution";

async function reserve(
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  guard: McpCompositeGuard,
) {
  const phase = nextCompositePhase(record);
  if (!phase || phase.status !== "unbound" || !record.targets.length)
    compositeError(
      "Review requires fixed saved targets and an unissued phase.",
    );
  const pass = record.phases.filter((item) => item.report).length + 1;
  if (pass > record.plan.maxReviewPasses)
    compositeError("The authorized host review pass budget is exhausted.");
  const cost = zeroCompositeCost();
  cost.admissions = 1;
  cost.pageAttempts = record.targets.length;
  reserveCompositeCost(record, cost);
  phase.status = "running";
  record.status = "running";
  return saveCompositeRecord(repository, record, guard);
}
async function execute(
  native: McpCompositeNative,
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  signal: AbortSignal,
  guard: McpCompositeGuard,
) {
  const phase = nextCompositePhase(record);
  if (!phase) compositeError("Review phase disappeared before rendering.");
  const pass = record.phases.filter((item) => item.report).length + 1;
  const publicationGuard: McpCompositeGuard = (scopes) => {
    signal.throwIfAborted();
    guard(scopes);
  };
  try {
    const evidence = await native.renderEvidence(
      record,
      phase.id,
      pass,
      signal,
      guard,
    );
    publicationGuard();
    const latest = await repository.load(record.owner, record.id);
    publicationGuard();
    const current = nextCompositePhase(latest);
    if (!current || current.id !== phase.id || current.status !== "running")
      compositeError("Review changed while the native render settled.");
    current.evidence = assertCompositeEvidence(
      latest,
      phase.id,
      pass,
      evidence,
    );
    current.status = "awaiting-review";
    latest.status = "awaiting-review";
    await saveCompositeRecord(repository, latest, publicationGuard);
  } catch (error) {
    try {
      await hold(repository, record, guard);
    } catch (checkpointError) {
      throw new AggregateError(
        [error, checkpointError],
        "Rendered evidence could not be durably checkpointed.",
        { cause: checkpointError },
      );
    }
    throw error;
  }
}
async function hold(
  repository: McpCompositeRepository,
  record: McpCompositeRecord,
  guard: McpCompositeGuard,
) {
  const latest = await repository.load(record.owner, record.id);
  const current = nextCompositePhase(latest);
  if (current) current.status = "held";
  if (latest.status !== "cancelled") latest.status = "held";
  latest.stopReason = "interrupted";
  return saveCompositeRecord(repository, latest, guard);
}
export const renderCompositeReview = { reserve, execute, hold };
