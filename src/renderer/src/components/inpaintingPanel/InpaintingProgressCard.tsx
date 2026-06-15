import React from "react";
import type { JobState } from "../../../../shared/types";
import type { ProgressSnapshot } from "../../lib/jobProgress";
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
  const current =
    progressSnapshot?.mode === "determinate"
      ? progressSnapshot.current
      : jobState.progressCurrent;
  const total =
    progressSnapshot?.mode === "determinate"
      ? progressSnapshot.total
      : jobState.progressTotal;
  const ratio =
    progressSnapshot?.mode === "determinate"
      ? progressSnapshot.ratio
      : Number.isFinite(current) && Number.isFinite(total) && (total ?? 0) > 0
        ? Math.min(1, Math.max(0, (current ?? 0) / (total ?? 1)))
        : 0;
  const detail =
    jobState.status === "completed" && jobState.detail
      ? jobState.detail
      : jobState.detail ||
        (Number.isFinite(jobState.pageTotal)
          ? `${jobState.pageTotal}페이지 처리 중`
          : "인페인팅 작업 진행 중");
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
      <div className="progress-track" aria-hidden="true">
        <div
          className="progress-fill"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      {jobState.status === "starting" || jobState.status === "running" ? (
        <Button variant="danger" size="sm" onClick={onCancel}>
          취소
        </Button>
      ) : null}
    </div>
  );
}
