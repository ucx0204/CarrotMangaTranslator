import React from "react";
import { useTranslation } from "react-i18next";
import type { JobState } from "../../../shared/jobTypes";
import type { ProgressSnapshot } from "../lib/jobProgress";
import { useEtaText } from "../hooks/useEtaText";
import { ProgressBar } from "./ui/ProgressBar";

export type JobProgressReadoutProps = {
  jobState: JobState;
  progressSnapshot: ProgressSnapshot | null;
  /** Extra chips shown under the bar, e.g. transferred bytes. */
  stats?: React.ReactNode;
  /**
   * Replaces the standard "in progress" wording when the surface knows something
   * more specific, e.g. an installer that only has log output to go on.
   */
  indeterminateLabel?: string;
  /** Replaces only the displayed/accessible value while preserving numeric progress. */
  valueText?: string;
  showDetail?: boolean;
  showEta?: boolean;
};

/**
 * The single job progress readout: headline, count, detail, ETA, and bar.
 *
 * Every progress surface renders this so the bar always means the same thing.
 * In particular the bar is always fed counts (`value`/`max`), never a ratio, so
 * `aria-valuenow` reports "3 of 10" rather than "0.3 of 1".
 */
export function JobProgressReadout({
  jobState,
  progressSnapshot,
  stats,
  indeterminateLabel,
  valueText: valueTextOverride,
  showDetail = true,
  showEta = true,
}: JobProgressReadoutProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const counts = resolveProgressCounts(jobState, progressSnapshot);
  const etaText = useEtaText(progressSnapshot);
  const headline = resolveProgressHeadline(jobState.progressText, counts);
  const valueText =
    valueTextOverride ??
    (counts
      ? `${counts.current} / ${counts.total}`
      : (indeterminateLabel ?? t("common.inProgress")));

  return (
    <>
      <div className="progress-meta">
        <span>{headline}</span>
        <strong>{valueText}</strong>
      </div>
      <ProgressNotes
        detail={showDetail ? jobState.detail : undefined}
        etaText={showEta ? etaText : null}
      />
      <ProgressBar
        label={headline}
        mode={counts ? "determinate" : "indeterminate"}
        value={counts?.current}
        max={counts?.total}
        valueText={valueText}
      />
      {stats ? <div className="progress-stats">{stats}</div> : null}
    </>
  );
}

function resolveProgressHeadline(
  progressText: string,
  counts: { current: number; total: number } | null,
): string {
  if (!counts) return progressText;
  const prefix = `${counts.current} / ${counts.total} `;
  return progressText.startsWith(prefix)
    ? progressText.slice(prefix.length)
    : progressText;
}

function ProgressNotes({
  detail,
  etaText,
}: {
  detail: string | undefined;
  etaText: string | null;
}): React.JSX.Element {
  const trimmedDetail = detail?.trim();
  return (
    <>
      {trimmedDetail ? (
        <small className="progress-detail">{trimmedDetail}</small>
      ) : null}
      {etaText ? <small className="progress-eta">{etaText}</small> : null}
    </>
  );
}

/** Determinate counts from the raw job counters, when no snapshot exists yet. */
function resolveJobStateCounts(
  jobState: JobState,
): { current: number; total: number } | null {
  const { progressCurrent: current, progressTotal: total } = jobState;
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(total) ||
    (total ?? 0) <= 0
  ) {
    return null;
  }
  return { current: current ?? 0, total: total ?? 0 };
}

/**
 * Determinate counts, or null when the job has no countable progress yet.
 * Falls back to the raw job counters when no snapshot has been derived.
 */
function resolveProgressCounts(
  jobState: JobState,
  progressSnapshot: ProgressSnapshot | null,
): { current: number; total: number } | null {
  if (progressSnapshot?.mode === "determinate") {
    return {
      current: progressSnapshot.current,
      total: progressSnapshot.total,
    };
  }
  if (progressSnapshot) return null;
  return resolveJobStateCounts(jobState);
}
