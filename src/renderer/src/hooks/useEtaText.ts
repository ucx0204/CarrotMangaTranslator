import React from "react";
import type { ProgressSnapshot } from "../lib/jobProgress";

/**
 * Estimates remaining time for a determinate job by averaging the progress
 * rate since the current run's first observed ratio. Returns null until there
 * is enough signal, or for indeterminate/log-only progress.
 */
export function useEtaText(snapshot: ProgressSnapshot | null): string | null {
  const [etaText, setEtaText] = React.useState<string | null>(null);
  const anchorRef = React.useRef<{ time: number; ratio: number } | null>(null);
  const ratio = snapshot?.mode === "determinate" ? snapshot.ratio : null;

  React.useEffect(() => {
    if (ratio === null) {
      anchorRef.current = null;
      setEtaText(null);
      return;
    }
    const now = Date.now();
    const anchor = anchorRef.current;
    if (!anchor || ratio < anchor.ratio) {
      anchorRef.current = { time: now, ratio };
      setEtaText(null);
      return;
    }
    if (ratio >= 1) {
      setEtaText(null);
      return;
    }
    const deltaRatio = ratio - anchor.ratio;
    const elapsed = now - anchor.time;
    if (deltaRatio < 0.02 || elapsed < 2000) {
      return;
    }
    const remainingMs = ((1 - ratio) * elapsed) / deltaRatio;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      setEtaText(null);
      return;
    }
    setEtaText(formatEta(remainingMs));
  }, [ratio]);

  return etaText;
}

function formatEta(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `약 ${totalSeconds}초 남음`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? `약 ${minutes}분 ${seconds}초 남음`
      : `약 ${minutes}분 남음`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return `약 ${hours}시간 ${remainderMinutes}분 남음`;
}
