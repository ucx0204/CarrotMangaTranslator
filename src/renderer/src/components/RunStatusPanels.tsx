import React from "react";
import type { ChapterSnapshot, JobState } from "../../../shared/types";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { Button } from "./ui";

export function RunPanel({
  currentChapter,
  jobActive,
  showProgressBar,
  progressSnapshot,
  jobState,
  onRunPending,
  onRunAll,
  onEnterInpainting,
  onCancelJob
}: {
  currentChapter: ChapterSnapshot | null;
  jobActive: boolean;
  showProgressBar: boolean;
  progressSnapshot: ProgressSnapshot | null;
  jobState: JobState;
  onRunPending: () => void;
  onRunAll: () => void;
  onEnterInpainting: () => void;
  onCancelJob: () => void;
}): React.JSX.Element {
  return (
    <section className="run-panel">
      <div className="run-title">
        <h2>{currentChapter?.title ?? "현재 화 없음"}</h2>
        <small>{currentChapter ? `${currentChapter.pages.length}페이지` : "보관함에서 화를 열어 주세요."}</small>
      </div>
      <Button variant="primary" fullWidth onClick={onRunPending} disabled={!currentChapter || jobActive}>
        이어서 번역
      </Button>
      <Button fullWidth onClick={onRunAll} disabled={!currentChapter || jobActive}>
        전체 다시 번역
      </Button>
      <Button fullWidth onClick={onEnterInpainting} disabled={!currentChapter || jobActive}>
        인페인팅
      </Button>
      {jobActive ? (
        <Button variant="danger" fullWidth onClick={onCancelJob}>
          취소
        </Button>
      ) : null}
      {showProgressBar && progressSnapshot ? <ProgressCard jobState={jobState} progressSnapshot={progressSnapshot} /> : null}
    </section>
  );
}

export function StatusPanel({ jobState, statusLines }: { jobState: JobState; statusLines: string[] }): React.JSX.Element {
  return (
    <section className="status-panel">
      <h2>상태</h2>
      <div className={`job-pill ${jobState.status}`}>{jobState.progressText}</div>
      <div className="status-log-scroll">
        {statusLines.length ? (
          statusLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
        ) : (
          <p className="muted-line">아직 표시할 상태가 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function ProgressCard({ jobState, progressSnapshot }: { jobState: JobState; progressSnapshot: ProgressSnapshot }): React.JSX.Element {
  return (
    <div className="progress-card">
      <div className="progress-meta">
        <span>{jobState.progressText}</span>
        {progressSnapshot.mode === "determinate" ? (
          <strong>
            {progressSnapshot.current} / {progressSnapshot.total}
          </strong>
        ) : (
          <strong>준비 중</strong>
        )}
      </div>
      {jobState.detail ? <small className="progress-detail">{jobState.detail}</small> : null}
      <div className={`progress-track ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`} aria-hidden="true">
        <div
          className={`progress-fill ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
          style={progressSnapshot.mode === "determinate" ? { width: `${Math.round(progressSnapshot.ratio * 100)}%` } : undefined}
        />
      </div>
    </div>
  );
}
