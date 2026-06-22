import React from "react";
import type { JobState } from "../../../../shared/jobTypes";
import type { ProgressSnapshot } from "../../lib/jobProgress";
import { useEtaText } from "../../hooks/useEtaText";
import { Button } from "../ui";

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
  const { current, ratio, total } = resolveProgressCardNumbers(
    jobState,
    progressSnapshot,
  );
  const detail = resolveProgressCardDetail(jobState);
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
          <strong>진행 중</strong>
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
          취소
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

function resolveProgressCardDetail(jobState: JobState): string {
  if (jobState.status === "completed" && jobState.detail) {
    return jobState.detail;
  }
  return (
    jobState.detail ??
    (Number.isFinite(jobState.pageTotal)
      ? `${jobState.pageTotal}페이지 처리 중`
      : "인페인팅 작업 진행 중")
  );
}

function isCancellableInpaintingJob(jobState: JobState): boolean {
  return jobState.status === "starting" || jobState.status === "running";
}
