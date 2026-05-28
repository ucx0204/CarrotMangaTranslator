import React from "react";
import * as Progress from "@radix-ui/react-progress";
import type { JobState } from "../../../shared/types";
import { formatBytes, type ProgressSnapshot } from "../lib/jobProgress";

type InstallProgressOverlayProps = {
  job: JobState;
  snapshot: ProgressSnapshot | null;
};

export function InstallProgressOverlay({ job, snapshot }: InstallProgressOverlayProps): React.JSX.Element | null {
  const logRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const element = logRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [job.installLogLines?.length]);

  if (!isInstallPhase(job.phase)) {
    return null;
  }

  const mode = snapshot?.mode ?? "log-only";
  const isDeterminate = snapshot?.mode === "determinate";
  const ratio = isDeterminate ? snapshot.ratio : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);
  const value = mode === "determinate" ? percent ?? 0 : undefined;
  const logLines = job.installLogLines ?? [];
  const byteStats = formatByteStats(job);

  return (
    <div className="install-progress-overlay" role="status" aria-live="polite">
      <div className="install-progress-card">
        <div className="install-progress-header">
          <span className="install-progress-kicker">{resolveKicker(job.phase)}</span>
          <strong>{job.progressText}</strong>
        </div>

        <Progress.Root className={`install-progress-root is-${mode}`} value={value} max={100}>
          <Progress.Indicator
            className="install-progress-indicator"
            style={mode === "determinate" ? { transform: `translateX(-${100 - (percent ?? 0)}%)` } : undefined}
          />
        </Progress.Root>

        <div className="install-progress-stats">
          <span>{resolveProgressLabel(mode, percent)}</span>
          {byteStats ? <span>{byteStats}</span> : null}
        </div>

        {job.detail ? <p>{job.detail}</p> : null}

        {logLines.length ? (
          <div ref={logRef} className="install-progress-log" aria-label="설치 로그">
            {logLines.map((line, index) => (
              <code key={`${line}-${index}`}>{line}</code>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function resolveProgressLabel(mode: ProgressSnapshot["mode"] | "log-only", percent: number | null): string {
  if (mode === "determinate" && percent !== null) {
    return `${percent}%`;
  }
  if (mode === "indeterminate") {
    return "진행 중";
  }
  return "로그 확인 중";
}

function formatByteStats(job: JobState): string | null {
  const current = formatBytes(job.progressBytes);
  const total = formatBytes(job.progressTotalBytes);
  if (current && total) {
    return `${current} / ${total}`;
  }
  if (current) {
    return current;
  }
  return null;
}

function isInstallPhase(phase: JobState["phase"]): boolean {
  return phase === "model_downloading" || phase === "ocr_downloading";
}

function resolveKicker(phase: JobState["phase"]): string {
  if (phase === "model_downloading") {
    return "Gemma 4 모델 준비";
  }
  if (phase === "ocr_downloading") {
    return "Paddle OCR 설치";
  }
  return "Paddle OCR 설치";
}
