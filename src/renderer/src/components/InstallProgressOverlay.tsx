import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import * as Progress from "@radix-ui/react-progress";
import type { JobState } from "../../../shared/jobTypes";
import { formatBytes, type ProgressSnapshot } from "../lib/jobProgress";
import { usePinnedInstallLog } from "./usePinnedInstallLog";

type InstallProgressOverlayProps = {
  job: JobState;
  snapshot: ProgressSnapshot | null;
};

export function InstallProgressOverlay({
  job,
  snapshot,
}: InstallProgressOverlayProps): React.JSX.Element | null {
  const { i18n, t } = useTranslation("components");
  const {
    handleLogKeyDown,
    handleLogScroll,
    handleLogWheel,
    handleOverlayPointerEndCapture,
    handleOverlayPointerStartCapture,
    logContentRef,
    logRef,
  } = usePinnedInstallLog(job);

  if (!isInstallPhase(job.phase)) {
    return null;
  }

  const progress = resolveInstallProgressDisplay(snapshot);
  const byteStats = formatByteStats(
    job,
    i18n.resolvedLanguage ?? i18n.language,
  );

  return (
    <div
      className="install-progress-overlay"
      role="dialog"
      aria-modal="true"
      aria-live="polite"
      onPointerDownCapture={handleOverlayPointerStartCapture}
      onPointerMoveCapture={stopOverlayEvent}
      onPointerUpCapture={handleOverlayPointerEndCapture}
      onPointerCancelCapture={handleOverlayPointerEndCapture}
      onClickCapture={stopOverlayEvent}
      onDoubleClickCapture={stopOverlayEvent}
      onContextMenuCapture={stopOverlayEvent}
      onWheel={stopOverlayEvent}
    >
      <div className="install-progress-card" onWheel={stopOverlayEvent}>
        <div className="install-progress-header">
          <span className="install-progress-kicker">
            {resolveKicker(job.phase, t)}
          </span>
          <strong>{job.progressText}</strong>
        </div>

        <Progress.Root
          className={`install-progress-root is-${progress.mode}`}
          value={progress.value}
          max={100}
        >
          <Progress.Indicator
            className="install-progress-indicator"
            style={
              progress.mode === "determinate"
                ? {
                    transform: `translateX(-${100 - (progress.percent ?? 0)}%)`,
                  }
                : undefined
            }
          />
        </Progress.Root>

        <div className="install-progress-stats">
          <span>
            {resolveProgressLabel(progress.mode, progress.percent, t)}
          </span>
          {byteStats ? <span>{byteStats}</span> : null}
        </div>

        {job.detail ? <p>{job.detail}</p> : null}

        <InstallLogPanel
          handleLogKeyDown={handleLogKeyDown}
          handleLogScroll={handleLogScroll}
          handleLogWheel={handleLogWheel}
          logContentRef={logContentRef}
          logLines={job.installLogLines ?? []}
          logRef={logRef}
        />
      </div>
    </div>
  );
}

function resolveInstallProgressDisplay(snapshot: ProgressSnapshot | null): {
  mode: ProgressSnapshot["mode"] | "log-only";
  percent: number | null;
  value: number | undefined;
} {
  const mode = snapshot?.mode ?? "log-only";
  const percent =
    snapshot?.mode === "determinate" ? Math.round(snapshot.ratio * 100) : null;
  return {
    mode,
    percent,
    value: mode === "determinate" ? (percent ?? 0) : undefined,
  };
}

function InstallLogPanel({
  handleLogKeyDown,
  handleLogScroll,
  handleLogWheel,
  logContentRef,
  logLines,
  logRef,
}: {
  handleLogKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleLogScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  handleLogWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  logContentRef: React.RefObject<HTMLDivElement | null>;
  logLines: string[];
  logRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (logLines.length === 0) {
    return null;
  }
  return (
    <div
      ref={logRef}
      className="install-progress-log"
      aria-label={t("install.logLabel")}
      tabIndex={0}
      onKeyDown={handleLogKeyDown}
      onScroll={handleLogScroll}
      onWheel={handleLogWheel}
    >
      <div ref={logContentRef} className="install-progress-log-content">
        {logLines.map((line, index) => (
          <code key={index}>{line}</code>
        ))}
      </div>
    </div>
  );
}

function stopOverlayEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}

function resolveProgressLabel(
  mode: ProgressSnapshot["mode"] | "log-only",
  percent: number | null,
  t: TFunction<"components">,
): string {
  if (mode === "determinate" && percent !== null) {
    return `${percent}%`;
  }
  if (mode === "indeterminate") {
    return t("common.inProgress");
  }
  return t("install.checkingLogs");
}

function formatByteStats(job: JobState, locale: string): string | null {
  const current = formatBytes(job.progressBytes, locale);
  const total = formatBytes(job.progressTotalBytes, locale);
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

function resolveKicker(
  phase: JobState["phase"],
  t: TFunction<"components">,
): string {
  if (phase === "model_downloading") {
    return t("install.preparingModel");
  }
  if (phase === "ocr_downloading") {
    return t("install.installingOcr");
  }
  return t("install.installingOcr");
}
