import type { JobEvent, JobState } from "../../../shared/jobTypes";

export type AggregateJobEventGuard = {
  activeJobIds: Set<string>;
  protectedJobIds: Set<string>;
};

export function createAggregateJobEventGuard(): AggregateJobEventGuard {
  return { activeJobIds: new Set(), protectedJobIds: new Set() };
}

export function shouldIgnoreAggregateJobEvent(
  current: JobState | undefined,
  event: JobEvent,
  guard: AggregateJobEventGuard,
  aggregateFlowActive: boolean,
): boolean {
  if (guard.protectedJobIds.has(event.id)) return true;
  if (isAggregateFlowTerminal(current) && guard.activeJobIds.has(event.id)) {
    return true;
  }
  if (isInpaintingFlowTerminal(current) && event.status !== "starting") {
    return true;
  }
  return Boolean(
    !aggregateFlowActive &&
    isAggregateFlowTerminal(current) &&
    isTerminalJobStatus(event.status),
  );
}

export function updateAggregateJobEventGuard(
  guard: AggregateJobEventGuard,
  aggregateFlowActive: boolean,
): void {
  if (aggregateFlowActive) {
    guard.activeJobIds.clear();
    return;
  }
  for (const jobId of guard.activeJobIds) guard.protectedJobIds.add(jobId);
  guard.activeJobIds.clear();
}

export function isAggregateFlowTerminal(
  current: JobState | undefined,
): boolean {
  return Boolean(
    current &&
    isAggregateFlowJobId(current.id) &&
    isTerminalJobStatus(current.status),
  );
}

export function isTerminalJobStatus(status: JobState["status"]): boolean {
  return (
    status === "cancelled" || status === "failed" || status === "completed"
  );
}

function isAggregateFlowJobId(jobId: string): boolean {
  return (
    jobId.startsWith("translation-flow-") ||
    jobId.startsWith("inpainting-flow-")
  );
}

function isInpaintingFlowTerminal(current: JobState | undefined): boolean {
  return Boolean(
    current?.id.startsWith("inpainting-flow-") &&
    isTerminalJobStatus(current.status),
  );
}
