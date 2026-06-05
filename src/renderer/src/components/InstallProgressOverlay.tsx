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
  const logPinnedToBottomRef = React.useRef(true);
  const logLineCount = job.installLogLines?.length ?? 0;

  const scrollLogToBottom = React.useCallback(() => {
    const element = logRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  React.useLayoutEffect(() => {
    if (!logPinnedToBottomRef.current) {
      return;
    }
    scrollLogToBottom();
    const frame = window.requestAnimationFrame(scrollLogToBottom);
    return () => window.cancelAnimationFrame(frame);
  }, [logLineCount, scrollLogToBottom]);

  React.useEffect(() => {
    logPinnedToBottomRef.current = true;
    scrollLogToBottom();
  }, [job.phase, scrollLogToBottom]);

  const handleLogScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    logPinnedToBottomRef.current = isScrolledNearBottom(event.currentTarget);
  }, []);

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
    <div
      className="install-progress-overlay"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      onPointerDownCapture={stopOverlayEvent}
      onPointerMoveCapture={stopOverlayEvent}
      onPointerUpCapture={stopOverlayEvent}
      onClickCapture={stopOverlayEvent}
      onDoubleClickCapture={stopOverlayEvent}
      onContextMenuCapture={stopOverlayEvent}
      onWheel={stopOverlayEvent}
    >
      <div className="install-progress-card" onWheel={stopOverlayEvent}>
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
          <div
            ref={logRef}
            className="install-progress-log"
            aria-label="설치 로그"
            onScroll={handleLogScroll}
            onWheel={stopOverlayEvent}
          >
            {logLines.map((line, index) => (
              <code key={`${line}-${index}`}>{line}</code>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function stopOverlayEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

function isScrolledNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 12;
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
