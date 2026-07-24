import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../../shared/jobTypes";
import type { ProgressSnapshot } from "../../lib/jobProgress";
import { useEtaText } from "../../hooks/useEtaText";
import { Button } from "../ui/Button";

type InpaintingProgressCardProps = {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  onCancel: () => void;
};

export function InpaintingProgressCard({
  jobState,
  progressSnapshot,
  onCancel,
}: InpaintingProgressCardProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const { current, ratio, total } = resolveProgressCardNumbers(
    jobState,
    progressSnapshot,
  );
  const detail = resolveProgressCardDetail(jobState, t);
  const etaText = useEtaText(progressSnapshot);

  return (
    <div className={`inpainting-progress-card ${jobState.status}`}>
      <div className="progress-meta">
        <span>{jobState.progressText}</span>
        {Number.isFinite(current) &&
        Number.isFinite(total) &&
        (total ?? 0) > 0 ? (
          <strong>
            {current} / {total}
          </strong>
        ) : (
          <strong>{t("common.inProgress")}</strong>
        )}
      </div>
      <small>{detail}</small>
      {etaText ? <small className="progress-eta">{etaText}</small> : null}
      <div className="progress-track" aria-hidden="true">
        <div
          className="progress-fill"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      {isCancellableInpaintingJob(jobState) ? (
        <Button variant="danger" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      ) : null}
    </div>
  );
}

function resolveProgressCardNumbers(
  jobState: JobState,
  progressSnapshot: ProgressSnapshot | null,
): {
  current: number | undefined;
  ratio: number;
  total: number | undefined;
} {
  if (progressSnapshot?.mode === "determinate") {
    return {
      current: progressSnapshot.current,
      ratio: progressSnapshot.ratio,
      total: progressSnapshot.total,
    };
  }
  const current = jobState.progressCurrent;
  const total = jobState.progressTotal;
  return {
    current,
    ratio: resolveFallbackProgressRatio(current, total),
    total,
  };
}

function resolveFallbackProgressRatio(
  current: number | undefined,
  total: number | undefined,
): number {
  return Number.isFinite(current) && Number.isFinite(total) && (total ?? 0) > 0
    ? Math.min(1, Math.max(0, (current ?? 0) / (total ?? 1)))
    : 0;
}

function resolveProgressCardDetail(
  jobState: JobState,
  t: TFunction<"components">,
): string {
  if (jobState.status === "completed" && jobState.detail) {
    return jobState.detail;
  }
  return (
    jobState.detail ??
    (Number.isFinite(jobState.pageTotal)
      ? t("inpainting.progress.processingPages", {
          count: jobState.pageTotal,
        })
      : t("inpainting.progress.inProgress"))
  );
}

function isCancellableInpaintingJob(jobState: JobState): boolean {
  return jobState.status === "starting" || jobState.status === "running";
}
