import type { JobEvent, JobPhase, JobState } from "../../../shared/jobTypes";

type JobWithProgress = Pick<
  JobState,
  | "status"
  | "phase"
  | "progressMode"
  | "progressCurrent"
  | "progressTotal"
  | "progressPercent"
  | "progressBytes"
  | "progressTotalBytes"
  | "progressBytesPerSecond"
  | "pageIndex"
  | "pageTotal"
  | "attempt"
  | "attemptTotal"
> & {
  progressText?: string;
};

export type ProgressSnapshot =
  | {
      mode: "indeterminate";
    }
  | {
      mode: "log-only";
    }
  | {
      mode: "determinate";
      current: number;
      total: number;
      ratio: number;
    };

const PROGRESS_TEXT_FALLBACK_BY_PHASE: Partial<Record<JobPhase, string>> = {
  booting: "모델 준비 중",
  model_downloading: "모델 다운로드/서버 준비 중",
  inpainting_preparing: "인페인팅 준비 중",
  finalizing: "결과 정리 중",
  done: "작업 완료",
};

const STATIC_LABEL_BY_PHASE: Partial<Record<JobPhase, string>> = {
  ocr_downloading: "Paddle OCR 다운로드/설치 중",
  ready: "모델 준비 완료",
  cancelled: "작업이 취소됨",
  failed: "작업 실패",
};

const PAGE_SUFFIX_BY_PHASE: Partial<Record<JobPhase, string>> = {
  ocr_preparing: "Paddle OCR 준비 중",
  model_requesting: "AI 번역 요청 중",
  page_running: "번역 중",
  page_done: "완료",
  page_skipped: "건너뜀",
};

const PROGRESS_TEXT_OR_PAGE_SUFFIX_BY_PHASE: Partial<Record<JobPhase, string>> =
  {
    inpainting_running: "원문 지우는 중",
    inpainting_done: "원문 지우기 완료",
  };

export function formatJobLabel(job: JobWithProgress): string {
  if (!job.phase) {
    return fallbackFromStatus(job.status);
  }
  const progressTextFallback = PROGRESS_TEXT_FALLBACK_BY_PHASE[job.phase];
  if (progressTextFallback) {
    return trimmedProgressText(job) ?? progressTextFallback;
  }
  const staticLabel = STATIC_LABEL_BY_PHASE[job.phase];
  if (staticLabel) {
    return staticLabel;
  }
  if (job.phase === "ocr_running") {
    return formatOcrRunningLabel(job);
  }
  if (job.phase === "page_retry") {
    return formatRetryLabel(job);
  }
  const pageSuffix = PAGE_SUFFIX_BY_PHASE[job.phase];
  if (pageSuffix) {
    return formatPageLabel(job, pageSuffix);
  }
  const progressTextOrPageSuffix =
    PROGRESS_TEXT_OR_PAGE_SUFFIX_BY_PHASE[job.phase];
  if (progressTextOrPageSuffix) {
    return (
      trimmedProgressText(job) ?? formatPageLabel(job, progressTextOrPageSuffix)
    );
  }
  return fallbackFromStatus(job.status);
}

export function formatJobEventLine(event: JobEvent): string {
  return formatJobLabel(event);
}

export function resolveProgressSnapshot(
  job: JobWithProgress,
): ProgressSnapshot | null {
  const explicitSnapshot = resolveExplicitProgressSnapshot(job);
  if (explicitSnapshot !== undefined) {
    return explicitSnapshot;
  }
  if (isIndeterminatePhase(job.phase)) {
    return { mode: "indeterminate" };
  }
  return resolveCountProgressSnapshot(job);
}

function resolveExplicitProgressSnapshot(
  job: JobWithProgress,
): ProgressSnapshot | null | undefined {
  if (job.progressMode === "log-only") {
    return { mode: "log-only" };
  }
  if (job.progressMode === "indeterminate") {
    return { mode: "indeterminate" };
  }
  if (Number.isFinite(job.progressPercent)) {
    return progressPercentSnapshot(Number(job.progressPercent));
  }
  return job.progressMode === "determinate" ? null : undefined;
}

function progressPercentSnapshot(progressPercent: number): ProgressSnapshot {
  const ratio = Math.max(0, Math.min(1, progressPercent));
  return {
    mode: "determinate",
    current: Math.round(ratio * 100),
    total: 100,
    ratio,
  };
}

function resolveCountProgressSnapshot(
  job: JobWithProgress,
): ProgressSnapshot | null {
  if (
    !Number.isFinite(job.progressCurrent) ||
    !Number.isFinite(job.progressTotal) ||
    (job.progressTotal ?? 0) <= 0
  ) {
    return null;
  }

  const total = Math.max(1, Math.floor(job.progressTotal ?? 0));
  const current = Math.min(
    total,
    Math.max(0, Math.floor(job.progressCurrent ?? 0)),
  );
  return {
    mode: "determinate",
    current,
    total,
    ratio: current / total,
  };
}

function isIndeterminatePhase(phase: JobPhase | undefined): boolean {
  return phase === "booting" || phase === "model_downloading";
}

export function formatBytes(bytes: number | null | undefined): string | null {
  if (!Number.isFinite(bytes) || (bytes ?? 0) < 0) {
    return null;
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes ?? 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function summarizeWarnings(warnings: string[]): string | null {
  if (warnings.length === 0) {
    return null;
  }

  const skipped = warnings.filter((warning) =>
    warning.includes("건너뜁니다"),
  ).length;
  const uncertain = warnings.filter((warning) =>
    warning.includes("불확실한 OCR"),
  ).length;
  if (skipped > 0 && uncertain > 0) {
    return `일부 페이지를 건너뛰었고 OCR 확인이 필요한 블록도 있습니다.`;
  }
  if (skipped > 0) {
    return `일부 페이지는 건너뛰고 다음 페이지로 진행했습니다.`;
  }
  if (uncertain > 0) {
    return `일부 블록은 OCR 확인이 더 필요합니다.`;
  }
  return `중간 경고가 있었지만 작업은 계속 진행되었습니다.`;
}

function formatPageLabel(job: JobWithProgress, suffix: string): string {
  if (hasPageIndex(job)) {
    return `${job.pageIndex} / ${job.pageTotal} 페이지 ${suffix}`;
  }
  return `페이지 ${suffix}`;
}

function formatOcrRunningLabel(job: JobWithProgress): string {
  if (!hasPageIndex(job)) {
    return trimmedProgressText(job) ?? "Paddle OCR 분석 중";
  }
  return formatPageLabel(job, "Paddle OCR 분석 중");
}

function trimmedProgressText(job: JobWithProgress): string | null {
  return job.progressText?.trim() || null;
}

function hasPageIndex(job: JobWithProgress): boolean {
  return (
    Number.isFinite(job.pageIndex) &&
    Number.isFinite(job.pageTotal) &&
    (job.pageTotal ?? 0) > 0
  );
}

function formatRetryLabel(job: JobWithProgress): string {
  if (
    Number.isFinite(job.pageIndex) &&
    Number.isFinite(job.pageTotal) &&
    Number.isFinite(job.attempt) &&
    Number.isFinite(job.attemptTotal)
  ) {
    return `${job.pageIndex} / ${job.pageTotal} 페이지 재시도 ${job.attempt} / ${job.attemptTotal}`;
  }
  return "페이지 재시도 중";
}

function fallbackFromStatus(status: JobState["status"]): string {
  switch (status) {
    case "starting":
      return "모델 준비 중";
    case "running":
      return "작업 진행 중";
    case "cancelling":
      return "작업 취소 중";
    case "cancelled":
      return "작업이 취소됨";
    case "failed":
      return "작업 실패";
    case "completed":
      return "번역 완료";
    default:
      return "대기 중";
  }
}
