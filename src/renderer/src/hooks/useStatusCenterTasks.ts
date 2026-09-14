import { useEffect, useRef, useState } from "react";
import type { JobState } from "../../../shared/jobTypes";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { appGateway } from "../api/appGateway";
import { analysisGateway } from "../api/analysisGateway";
import { isTerminalJobStatus } from "../../../shared/jobContracts";

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
  const versions = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    const update = (task: StatusCenterTask, live: boolean) => {
      if (disposed || (!live && versions.current.has(task.id))) return;
      if (live) versions.current.add(task.id);
      setTasks((current) => {
        const previous = current.find((entry) => entry.id === task.id);
        if (previous?.job && isTerminalJobStatus(previous.job.status))
          return current;
        if (
          previous?.operation &&
          task.operation &&
          previous.operation.updatedAt > task.operation.updatedAt
        )
          return current;
        const rest = current.filter((entry) => entry.id !== task.id);
        const next = previous
          ? current.map((entry) => (entry.id === task.id ? task : entry))
          : [...rest, task];
        const retained = next.slice(-60);
        const ids = new Set(retained.map((entry) => entry.id));
        for (const id of versions.current)
          if (!ids.has(id)) versions.current.delete(id);
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
    select,
  };
}

function resolveStatusCenterSelection(
  tasks: StatusCenterTask[],
  selectedId: string | null,
  foreground: JobState,
  operation?: AppOperationActivityEvent | null,
) {
  const fallback = { id: foreground.id, job: foreground };
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
    foreground.status !== "idle"
  )
    visible.unshift(fallback);
  if (
    operation &&
    (operation.id === selectedId ||
      ["running", "cancelling"].includes(operation.status)) &&
    !visible.some((task) => task.id === operation.id)
  )
    visible.push({ id: operation.id, operation });
  const selected =
    visible.find((task) => task.id === selectedId) ??
    visible.find((task) => task.id === foreground.id) ??
    visible[0] ??
    fallback;
  return { tasks: visible, selected };
}
