import React from "react";
import { useTranslation } from "react-i18next";
import type { ProgressSnapshot } from "../lib/jobProgress";

/**
 * Estimates remaining time for a determinate job by averaging the progress
 * rate since the current run's first observed ratio. Returns null until there
 * is enough signal, or for indeterminate/log-only progress.
 */
export function useEtaText(snapshot: ProgressSnapshot | null): string | null {
  const { t } = useTranslation("renderer");
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
    setEtaText(formatEta(remainingMs, t));
  }, [ratio, t]);

  return etaText;
}

function formatEta(
  ms: number,
  t: ReturnType<typeof useTranslation<"renderer">>["t"],
): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return t("eta.seconds", { count: totalSeconds });
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0
      ? t("eta.minutesSeconds", { minutes, seconds })
      : t("eta.minutes", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return t("eta.hoursMinutes", { hours, minutes: remainderMinutes });
}
