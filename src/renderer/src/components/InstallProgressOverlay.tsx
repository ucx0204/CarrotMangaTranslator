import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import { formatBytes, type ProgressSnapshot } from "../lib/jobProgress";
import { JobProgressReadout } from "./JobProgressReadout";
import { Modal } from "./ui/Modal";
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

  const byteStats = formatByteStats(
    job,
    i18n.resolvedLanguage ?? i18n.language,
  );

  return (
    <Modal
      title={resolveKicker(job.phase, t)}
      width="min(680px, calc(100vw - 96px))"
      maxHeight="720px"
      // `install-progress-content` owns the padding; the body must not add its own.
      bodyLayout="bare"
      bodyClassName="install-progress-body"
      elevation="blocking"
      closeOnEsc={false}
    >
      <div
        className="install-progress-content"
        onPointerDownCapture={handleOverlayPointerStartCapture}
        onPointerUpCapture={handleOverlayPointerEndCapture}
        onPointerCancelCapture={handleOverlayPointerEndCapture}
      >
        <strong className="install-progress-headline">
          {job.progressText}
        </strong>

        <div className="install-progress-readout" aria-live="polite">
          <JobProgressReadout
            jobState={job}
            progressSnapshot={snapshot}
            indeterminateLabel={
              snapshot ? undefined : t("install.checkingLogs")
            }
            stats={byteStats ? <span>{byteStats}</span> : null}
          />
        </div>

        <InstallLogPanel
          handleLogKeyDown={handleLogKeyDown}
          handleLogScroll={handleLogScroll}
          handleLogWheel={handleLogWheel}
          logContentRef={logContentRef}
          logLines={job.installLogLines ?? []}
          logRef={logRef}
        />
      </div>
    </Modal>
  );
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
