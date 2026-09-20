import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { isTerminalJobStatus } from "../../../shared/jobContracts";
import {
  formatAppOperationActivity,
  isAppOperationActive,
} from "../lib/appOperationPresentation";
import {
  clearStatusCenterHistory,
  loadStatusCenterHistory,
  saveStatusCenterHistory,
  STATUS_CENTER_HISTORY_LIMIT,
  type StatusCenterHistoryEntry,
} from "../lib/statusCenterHistoryStore";
import type { StatusCenterTask } from "./useStatusCenterTasks";

/** Every task owns its completion record, including tasks never selected in the dock. */
export function useStatusJobHistory(
  jobState: JobState,
  operation: AppOperationActivityEvent | null,
  t: TFunction<"renderer">,
  completed: StatusCenterTask[],
) {
  const recorded = useRef(new Set<string>());
  const [entries, setEntries] = useState(loadStatusCenterHistory);
  useEffect(() => {
    const candidates = [
      ...completed,
      { id: jobState.id, job: jobState },
      ...(operation ? [{ id: operation.id, operation }] : []),
    ];
    const fresh: StatusCenterHistoryEntry[] = [];
    for (const task of candidates) {
      if (recorded.current.has(task.id)) continue;
      const entry = toHistoryEntry(task, t);
      if (!entry) continue;
      recorded.current.add(task.id);
      fresh.unshift(entry);
    }
    if (!fresh.length) return;
    setEntries((current) =>
      [
        ...fresh,
        ...current.filter(
          (entry) => !fresh.some((next) => next.id === entry.id),
        ),
      ].slice(0, STATUS_CENTER_HISTORY_LIMIT),
    );
  }, [completed, jobState, operation, t]);
  useEffect(() => saveStatusCenterHistory(entries), [entries]);
  const clear = useCallback(() => {
    setEntries([]);
    clearStatusCenterHistory();
  }, []);
  return { entries, clear };
}

function toHistoryEntry(
  task: StatusCenterTask,
  t: TFunction<"renderer">,
): StatusCenterHistoryEntry | null {
  const job = task.job;
  if (job && isTerminalJobStatus(job.status))
    return {
      id: job.id,
      source: "job",
      kind: job.kind,
      status: job.status,
      completedAt: Date.now(),
      progressText: job.progressText,
      pageTotal: job.pageTotal ?? job.progressTotal,
    };
  const event = task.operation;
  if (!event || isAppOperationActive(event)) return null;
  return {
    id: event.id,
    source: "operation",
    kind: event.kind,
    status: event.status,
    completedAt: event.updatedAt,
    ...(event.failureCode ? { failureCode: event.failureCode } : {}),
    ...(event.phase ? { phase: event.phase } : {}),
    ...(event.sourceKind ? { sourceKind: event.sourceKind } : {}),
    progressText: formatAppOperationActivity(event, t),
  };
}
