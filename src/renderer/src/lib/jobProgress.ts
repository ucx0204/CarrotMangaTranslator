import type { JobEvent, JobPhase, JobState } from "../../../shared/jobTypes";
import type { TFunction } from "i18next";
import {
  fallbackJobLabelFromStatus,
  formatElapsedLine,
  formatJobFailureGuidance,
  translate,
} from "./appHelpers";

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
  | "failureGuidance"
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

const PROGRESS_TEXT_FALLBACK_BY_PHASE: Partial<
  Record<JobPhase, { key: string; fallback: string }>
> = {
  booting: { key: "job.phase.booting", fallback: "모델 준비 중" },
  model_downloading: {
    key: "job.phase.modelDownloading",
    fallback: "모델 다운로드/서버 준비 중",
  },
  inpainting_preparing: {
    key: "job.phase.inpaintingPreparing",
    fallback: "인페인팅 준비 중",
  },
  finalizing: { key: "job.phase.finalizing", fallback: "결과 정리 중" },
  done: { key: "job.phase.done", fallback: "작업 완료" },
  partial: { key: "job.phase.partial", fallback: "작업 부분 완료" },
};

const STATIC_LABEL_BY_PHASE: Partial<
  Record<JobPhase, { key: string; fallback: string }>
> = {
  ocr_downloading: {
    key: "job.phase.ocrDownloading",
    fallback: "Paddle OCR 다운로드/설치 중",
  },
  ready: { key: "job.phase.ready", fallback: "모델 준비 완료" },
  cancelled: { key: "job.phase.cancelled", fallback: "작업이 취소됨" },
  failed: { key: "job.phase.failed", fallback: "작업 실패" },
};

const PAGE_SUFFIX_BY_PHASE: Partial<
  Record<JobPhase, { key: string; fallback: string }>
> = {
  ocr_preparing: {
    key: "job.phase.ocrPreparing",
    fallback: "Paddle OCR 준비 중",
  },
  model_requesting: {
    key: "job.phase.modelRequesting",
    fallback: "AI 번역 요청 중",
  },
  page_running: { key: "job.phase.pageRunning", fallback: "번역 중" },
  page_done: { key: "job.phase.pageDone", fallback: "완료" },
  page_skipped: { key: "job.phase.pageSkipped", fallback: "건너뜀" },
};

const PROGRESS_TEXT_OR_PAGE_SUFFIX_BY_PHASE: Partial<
  Record<JobPhase, { key: string; fallback: string }>
> = {
  inpainting_running: {
    key: "job.phase.inpaintingRunning",
    fallback: "원문 지우는 중",
  },
  inpainting_done: {
    key: "job.phase.inpaintingDone",
    fallback: "원문 지우기 완료",
  },
};

export function formatJobLabel(
  job: JobWithProgress,
  t?: TFunction<"renderer">,
  options: { preserveUnknownProgressText?: boolean } = {},
): string {
  const failureGuidance = resolveFailedJobGuidance(job, t);
  if (failureGuidance) {
    return failureGuidance;
  }
  const preserveUnknownProgressText =
    options.preserveUnknownProgressText ?? true;
  if (!job.phase) {
    return fallbackJobLabelFromStatus(job.status, t);
  }
  const directPhaseLabel = formatDirectPhaseLabel(
    job,
    t,
    preserveUnknownProgressText,
  );
  if (directPhaseLabel) {
    return directPhaseLabel;
  }
  if (job.phase === "ocr_running") {
    return formatOcrRunningLabel(job, t, preserveUnknownProgressText);
  }
  if (job.phase === "page_retry") {
    return formatRetryLabel(job, t);
  }
  const pageSuffix = PAGE_SUFFIX_BY_PHASE[job.phase];
  if (pageSuffix) {
    return formatPageLabel(
      job,
      translate(t, pageSuffix.key, pageSuffix.fallback),
      t,
    );
  }
  const progressTextOrPageSuffix =
    PROGRESS_TEXT_OR_PAGE_SUFFIX_BY_PHASE[job.phase];
  if (progressTextOrPageSuffix) {
    return (
      translatedProgressText(job, t, preserveUnknownProgressText) ??
      formatPageLabel(
        job,
        translate(
          t,
          progressTextOrPageSuffix.key,
          progressTextOrPageSuffix.fallback,
        ),
        t,
      )
    );
  }
  return fallbackJobLabelFromStatus(job.status, t);
}

function resolveFailedJobGuidance(
  job: JobWithProgress,
  t?: TFunction<"renderer">,
): string | null {
  return job.status === "failed" ? formatJobFailureGuidance(job, t) : null;
}

function formatDirectPhaseLabel(
  job: JobWithProgress,
  t: TFunction<"renderer"> | undefined,
  preserveUnknownProgressText: boolean,
): string | null {
  const progressTextFallback = job.phase
    ? PROGRESS_TEXT_FALLBACK_BY_PHASE[job.phase]
    : undefined;
  if (progressTextFallback) {
    return (
      translatedProgressText(job, t, preserveUnknownProgressText) ??
      translate(t, progressTextFallback.key, progressTextFallback.fallback)
    );
  }
  const staticLabel = job.phase ? STATIC_LABEL_BY_PHASE[job.phase] : undefined;
  return staticLabel
    ? translate(t, staticLabel.key, staticLabel.fallback)
    : null;
}

export function formatJobEventLine(
  event: JobEvent,
  t?: TFunction<"renderer">,
): string {
  const label = formatJobLabel(event, t);
  if (event.phase === "page_done") {
    return formatElapsedLine(label, event.pageElapsedMs, "page", t);
  }
  if (event.phase === "done" && event.status === "completed") {
    return formatElapsedLine(label, event.jobElapsedMs, "total", t);
  }
  return label;
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

export function formatBytes(
  bytes: number | null | undefined,
  locale?: string,
): string | null {
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
  const formatted = locale
    ? new Intl.NumberFormat(locale, {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      }).format(value)
    : value.toFixed(digits);
  return `${formatted} ${units[unitIndex]}`;
}

export function summarizeWarnings(
  warnings: string[],
  t?: TFunction<"renderer">,
): string | null {
  if (warnings.length === 0) {
    return null;
  }

  const skipped = warnings.filter(isSkippedPageWarning).length;
  const uncertain = warnings.filter(isUncertainOcrWarning).length;
  if (skipped > 0 && uncertain > 0) {
    return translate(
      t,
      "job.warnings.skippedAndUncertain",
      "일부 페이지를 건너뛰었고 OCR 확인이 필요한 블록도 있습니다.",
    );
  }
  if (skipped > 0) {
    return translate(
      t,
      "job.warnings.skipped",
      "일부 페이지는 건너뛰고 다음 페이지로 진행했습니다.",
    );
  }
  if (uncertain > 0) {
    return translate(
      t,
      "job.warnings.uncertain",
      "일부 블록은 OCR 확인이 더 필요합니다.",
    );
  }
  return translate(
    t,
    "job.warnings.generic",
    "중간 경고가 있었지만 작업은 계속 진행되었습니다.",
  );
}

function isSkippedPageWarning(warning: string): boolean {
  return warning.startsWith("page_skipped:") || warning.includes("건너뜁니다");
}

function isUncertainOcrWarning(warning: string): boolean {
  return (
    warning.startsWith("uncertain_ocr:") || warning.includes("불확실한 OCR")
  );
}

function formatPageLabel(
  job: JobWithProgress,
  suffix: string,
  t?: TFunction<"renderer">,
): string {
  if (hasPageIndex(job)) {
    return t
      ? t("job.pageProgress", {
          current: job.pageIndex,
          total: job.pageTotal,
          status: suffix,
        })
      : `${job.pageIndex} / ${job.pageTotal} 페이지 ${suffix}`;
  }
  return t ? t("job.pageStatus", { status: suffix }) : `페이지 ${suffix}`;
}

function formatOcrRunningLabel(
  job: JobWithProgress,
  t?: TFunction<"renderer">,
  preserveUnknownProgressText = true,
): string {
  if (!hasPageIndex(job)) {
    return (
      translatedProgressText(job, t, preserveUnknownProgressText) ??
      translate(t, "job.phase.ocrRunning", "Paddle OCR 분석 중")
    );
  }
  return formatPageLabel(
    job,
    translate(t, "job.phase.ocrRunning", "Paddle OCR 분석 중"),
    t,
  );
}

function trimmedProgressText(job: JobWithProgress): string | null {
  return job.progressText?.trim() || null;
}

function translatedProgressText(
  job: JobWithProgress,
  t?: TFunction<"renderer">,
  preserveUnknownProgressText = true,
): string | null {
  const text = trimmedProgressText(job);
  if (!text || !t) {
    return text;
  }
  const key = LEGACY_PROGRESS_TEXT_KEYS[text];
  return key ? t(key) : preserveUnknownProgressText ? text : null;
}

const LEGACY_PROGRESS_TEXT_KEYS: Record<string, string> = {
  "모델 준비 중": "job.phase.booting",
  "모델 다운로드/서버 준비 중": "job.phase.modelDownloading",
  "인페인팅 준비 중": "job.phase.inpaintingPreparing",
  "결과 정리 중": "job.phase.finalizing",
  "작업 완료": "job.phase.done",
  "Paddle OCR 선분석 완료": "job.phase.ocrPreanalysisDone",
};

function hasPageIndex(job: JobWithProgress): boolean {
  return (
    Number.isFinite(job.pageIndex) &&
    Number.isFinite(job.pageTotal) &&
    (job.pageTotal ?? 0) > 0
  );
}

function formatRetryLabel(
  job: JobWithProgress,
  t?: TFunction<"renderer">,
): string {
  if (
    Number.isFinite(job.pageIndex) &&
    Number.isFinite(job.pageTotal) &&
    Number.isFinite(job.attempt) &&
    Number.isFinite(job.attemptTotal)
  ) {
    return t
      ? t("job.pageRetry", {
          current: job.pageIndex,
          total: job.pageTotal,
          attempt: job.attempt,
          attemptTotal: job.attemptTotal,
        })
      : `${job.pageIndex} / ${job.pageTotal} 페이지 재시도 ${job.attempt} / ${job.attemptTotal}`;
  }
  return translate(t, "job.phase.pageRetry", "페이지 재시도 중");
}
