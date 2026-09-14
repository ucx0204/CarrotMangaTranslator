import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { CurrentStatusContent } from "./StatusPopoverDetails";
import type { useStatusCenterTasks } from "../hooks/useStatusCenterTasks";
import { useAppActivities } from "../hooks/useAppActivities";
import { appGateway } from "../api/appGateway";
import { analysisGateway } from "../api/analysisGateway";
import { resolveProgressSnapshot, formatJobLabel } from "../lib/jobProgress";
import { formatAppOperationActivity } from "../lib/appOperationPresentation";
import { toastNotificationPort } from "../lib/notificationPort";

export function ConcurrentTaskStatus(
  props: React.ComponentProps<typeof CurrentStatusContent> & {
    taskController: ReturnType<typeof useStatusCenterTasks>;
  },
): React.JSX.Element {
  const { t: rendererT } = useTranslation("renderer");
  const { tasks, selected, select } = props.taskController;
  const job = selected.job ?? props.jobState;
  return (
    <>
      {tasks.length > 1 ? (
        <div
          className="status-task-list"
          role="group"
          aria-label={rendererT("statusDock.concurrentTasks")}
        >
          {tasks.map((task) => (
            <Button
              key={task.id}
              size="sm"
              aria-pressed={task.id === selected.id}
              onClick={() => select(task.id)}
            >
              {task.operation
                ? formatAppOperationActivity(task.operation, rendererT)
                : task.job
                  ? task.job.progressText || formatJobLabel(task.job, rendererT)
                  : task.id}
            </Button>
          ))}
        </div>
      ) : null}
      <CurrentStatusContent
        {...props}
        jobState={job}
        operationActivity={selected.operation ?? null}
        progressSnapshot={
          selected.id === props.jobState.id
            ? props.progressSnapshot
            : resolveProgressSnapshot(job)
        }
        showProgressBar={
          selected.id === props.jobState.id
            ? props.showProgressBar
            : Boolean(selected.job)
        }
        onCancelJob={() =>
          selected.id === props.jobState.id
            ? props.onCancelJob()
            : run(() => analysisGateway.cancelJob({ jobId: selected.id }))
        }
        onCancelOperation={() =>
          selected.id === props.operationActivity?.id && props.onCancelOperation
            ? props.onCancelOperation()
            : run(() => appGateway.cancelAppOperation(selected.id))
        }
      />
      <PageHandoffStatus jobId={selected.id} />
    </>
  );
}

function PageHandoffStatus({ jobId }: { jobId: string }): React.JSX.Element {
  const activities = useAppActivities();
  const { t: rendererT } = useTranslation("renderer");
  return (
    <>
      {activities?.pages
        .filter(
          (page) =>
            page.jobId === jobId &&
            (page.phase === "waiting" || page.phase === "finishing-edits"),
        )
        .map((page) => (
          <div
            className="status-task-handoff"
            key={`${page.chapterId}/${page.pageId}`}
          >
            <p role="status">
              {page.reason ?? rendererT("statusDock.finishingEdits")}
            </p>
            {page.phase === "waiting" && page.requestId ? (
              <Button
                size="sm"
                onClick={() =>
                  run(() =>
                    page.requestId
                      ? appGateway.retryPageEditHandoff(page.requestId)
                      : Promise.resolve(false),
                  )
                }
              >
                {rendererT("statusDock.retryHandoff")}
              </Button>
            ) : null}
          </div>
        ))}
    </>
  );
}

function run(action: () => Promise<unknown>): void {
  void action().catch((error) =>
    toastNotificationPort.error(
      error instanceof Error ? error.message : String(error),
    ),
  );
}
