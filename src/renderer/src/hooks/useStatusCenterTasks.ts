import { useEffect, useRef, useState } from "react";
import type { JobState } from "../../../shared/jobTypes";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { appGateway } from "../api/appGateway";
import { analysisGateway } from "../api/analysisGateway";
import { isTerminalJobStatus } from "../../../shared/jobContracts";
import { isAppOperationActive } from "../lib/appOperationPresentation";

const RECENT_TASK_LIMIT = 60;

export type StatusCenterTask = {
  id: string;
  job?: JobState;
  operation?: AppOperationActivityEvent;
};

/** Keeps selection stable while independently arriving jobs update their own row. */
export function useStatusCenterTasks(
  foreground: JobState,
  operation?: AppOperationActivityEvent | null,
) {
  const [tasks, setTasks] = useState<StatusCenterTask[]>([]);
  const [selectedId, select] = useState<string | null>(null);
  // Retain terminal IDs for this subscription, even after their display rows expire.
  const versions = useRef(new Map<string, boolean>());
  useEffect(() => {
    let disposed = false;
    const update = (task: StatusCenterTask, live: boolean) => {
      if (
        disposed ||
        versions.current.get(task.id) === true ||
        (!live && versions.current.has(task.id))
      )
        return;
      if (live) versions.current.set(task.id, isFinishedTask(task));
      setTasks((current) => {
        const previous = current.find((entry) => entry.id === task.id);
        if (previous && isFinishedTask(previous)) return current;
        if (
          previous?.operation &&
          task.operation &&
          previous.operation.updatedAt > task.operation.updatedAt
        )
          return current;
        const rest = current.filter((entry) => entry.id !== task.id);
        const next =
          previous && !isFinishedTask(task)
            ? current.map((entry) => (entry.id === task.id ? task : entry))
            : [...rest, task];
        // Finished rows must never evict a still-running task.
        const finished = next.filter(isFinishedTask).slice(-RECENT_TASK_LIMIT);
        const retained = next.filter(
          (entry) => !isFinishedTask(entry) || finished.includes(entry),
        );
        const ids = new Set(retained.map((entry) => entry.id));
        for (const [id, finished] of versions.current)
          if (!finished && !ids.has(id)) versions.current.delete(id);
        return retained;
      });
    };
    const unsubJob = analysisGateway.onJobEvent((job) =>
      update({ id: job.id, job }, true),
    );
    const unsubOperation = appGateway.onAppOperationActivity((operation) =>
      update({ id: operation.id, operation }, true),
    );
    void Promise.all([
      appGateway.getActiveJobs(),
      appGateway.getActiveAppOperations(),
    ])
      .then(([jobs, operations]) => {
        jobs.forEach((job) => update({ id: job.id, job }, false));
        operations.forEach((operation) =>
          update({ id: operation.id, operation }, false),
        );
      })
      .catch((error) =>
        console.error("Could not load concurrent tasks", error),
      );
    return () => {
      disposed = true;
      unsubJob();
      unsubOperation();
    };
  }, []);
  return {
    ...resolveStatusCenterSelection(tasks, selectedId, foreground, operation),
    completed: tasks.filter(isFinishedTask),
    select,
  };
}

function isFinishedTask(task: StatusCenterTask): boolean {
  return task.job
    ? isTerminalJobStatus(task.job.status)
    : Boolean(task.operation && !isAppOperationActive(task.operation));
}

function resolveStatusCenterSelection(
  tasks: StatusCenterTask[],
  selectedId: string | null,
  foreground: JobState,
  operation?: AppOperationActivityEvent | null,
) {
  const fallback = tasks.find((task) => task.id === foreground.id) ?? {
    id: foreground.id,
    job: foreground,
  };
  const visible = tasks.filter(
    (task) =>
      task.id === selectedId ||
      (task.job
        ? !isTerminalJobStatus(task.job.status)
        : task.operation?.status === "running" ||
          task.operation?.status === "cancelling"),
  );
  if (
    !visible.some((task) => task.id === foreground.id) &&
    foreground.status !== "idle" &&
    !isFinishedTask(fallback)
  )
    visible.unshift(fallback);
  if (
    operation &&
    (operation.id === selectedId ||
      ["running", "cancelling"].includes(operation.status)) &&
    !tasks.some((task) => task.id === operation.id)
  )
    visible.push({ id: operation.id, operation });
  const selected =
    visible.find((task) => task.id === selectedId) ??
    visible.find((task) => task.id === foreground.id) ??
    visible[0] ??
    fallback;
  return { tasks: visible, selected };
}
