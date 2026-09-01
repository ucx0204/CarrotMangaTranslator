import React from "react";
import { useTranslation } from "react-i18next";
import type { AppOperationActivityEvent } from "../../../shared/appOperationTypes";
import { isAppOperationActive } from "../lib/appOperationPresentation";
import { formatBytes } from "../lib/jobProgressFormatting";
import { JobCancelButton } from "./RunStatusPanels";
import { ProgressBar } from "./ui/ProgressBar";

export function StatusOperationActivityFeedback({
  activity,
  onCancel,
}: {
  activity: AppOperationActivityEvent;
  onCancel?: () => void;
}): React.JSX.Element | null {
  const { i18n, t } = useTranslation("components");
  if (!isAppOperationActive(activity)) return null;
  const progress = resolveOperationProgress(activity);
  const valueText = progress
    ? formatOperationProgressValue(
        activity,
        progress,
        i18n.resolvedLanguage ?? i18n.language,
        t,
      )
    : t("common.inProgress");
  const waitingText = activity.waitingForUser
    ? t("statusDock.operation.waitingForUser")
    : null;
  return (
    <>
      <div className="operation-progress-card">
        <div className={`progress-meta ${waitingText ? "" : "value-only"}`}>
          {waitingText ? <span>{waitingText}</span> : null}
          <strong>{valueText}</strong>
        </div>
        <ProgressBar
          label={t("statusDock.operation.progressLabel")}
          mode={progress ? "determinate" : "indeterminate"}
          value={progress?.current}
          max={progress?.total}
          valueText={valueText}
        />
      </div>
      <OperationCancelControl activity={activity} onCancel={onCancel} />
    </>
  );
}

function OperationCancelControl({
  activity,
  onCancel,
}: {
  activity: AppOperationActivityEvent;
  onCancel?: () => void;
}): React.JSX.Element | null {
  if (
    !onCancel ||
    (!activity.cancellable && activity.status !== "cancelling")
  ) {
    return null;
  }
  return (
    <JobCancelButton
      cancelling={activity.status === "cancelling"}
      onCancel={onCancel}
    />
  );
}

function resolveOperationProgress(
  activity: AppOperationActivityEvent,
): { current: number; total: number } | null {
  const current = activity.progressCurrent;
  const total = activity.progressTotal;
  if (
    typeof current !== "number" ||
    !Number.isFinite(current) ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return {
    current: Math.min(total, Math.max(0, current)),
    total,
  };
}

function formatOperationProgressValue(
  activity: AppOperationActivityEvent,
  progress: { current: number; total: number },
  locale: string,
  t: ReturnType<typeof useTranslation<"components">>["t"],
): string {
  const { current, total } = progress;
  if (activity.progressUnit === "bytes") {
    return `${formatBytes(current, locale) ?? current} / ${
      formatBytes(total, locale) ?? total
    }`;
  }
  if (activity.progressUnit === "percent") {
    return t("statusDock.operation.percent", {
      value: Math.round((current / Math.max(1, total)) * 100),
    });
  }
  return `${Math.floor(current)} / ${Math.floor(total)}`;
}
