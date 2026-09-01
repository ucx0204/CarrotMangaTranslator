import type { JobEvent, JobPhase, JobState } from "../../../shared/jobTypes";
import type { TFunction } from "i18next";
import {
  isHayaiOcrPipeline,
  resolveOcrRendererKeyPrefix,
} from "../../../shared/ocrEngines";
import {
  fallbackJobLabelFromStatus,
  formatJobFailureGuidance,
  translate,
} from "./appHelpers";

type JobWithProgress = Pick<
  JobState,
  | "status"
  | "phase"
  | "ocrPipeline"
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
  ready: { key: "job.phase.ready", fallback: "모델 준비 완료" },
  cancelled: { key: "job.phase.cancelled", fallback: "작업이 취소됨" },
  failed: { key: "job.phase.failed", fallback: "작업 실패" },
};

const PAGE_SUFFIX_BY_PHASE: Partial<
  Record<JobPhase, { key: string; fallback: string }>
> = {
  model_requesting: {
    key: "job.phase.modelRequesting",
    fallback: "AI 번역 요청 중",
  },
  page_running: { key: "job.phase.pageRunning", fallback: "번역 중" },
  // The model request batch is already finished when page_done is emitted.
  // This event advances while the prepared pages are receiving their final
  // text typography (font matching / font-size fitting), so expose the work
  // that is actually running instead of describing each page as generically
  // complete.
  page_done: {
    key: "job.phase.pageTypography",
    fallback: "글자·폰트 맞춤 중",
  },
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
  const ocrLabel = formatOcrProgressLabel(job, t, preserveUnknownProgressText);
  if (ocrLabel) {
    return ocrLabel;
  }
  const directPhaseLabel = formatDirectPhaseLabel(
    job,
    t,
    preserveUnknownProgressText,
  );
  if (directPhaseLabel) {
    return directPhaseLabel;
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

function formatOcrProgressLabel(
  job: JobWithProgress,
  t: TFunction<"renderer"> | undefined,
  preserveUnknownProgressText: boolean,
): string | null {
  if (job.phase === "ocr_downloading") {
    return formatOcrPhaseLabel(job, "Downloading", t);
  }
  if (job.phase === "ocr_preparing") {
    const label = formatOcrPhaseLabel(job, "Preparing", t);
    return hasPageIndex(job) ? formatPageLabel(job, label, t) : label;
  }
  return job.phase === "ocr_running"
    ? formatOcrRunningLabel(job, t, preserveUnknownProgressText)
    : null;
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
  return formatJobLabel(event, t);
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
  const label = formatOcrPhaseLabel(job, "Running", t);
  if (!hasPageIndex(job)) {
    if (hasConflictingOcrBrand(job)) {
      return label;
    }
    return translatedProgressText(job, t, preserveUnknownProgressText) ?? label;
  }
  return formatPageLabel(job, label, t);
}

function hasConflictingOcrBrand(job: JobWithProgress): boolean {
  const text = trimmedProgressText(job);
  if (!text || !job.ocrPipeline) {
    return false;
  }
  return isHayaiOcrPipeline(job.ocrPipeline)
    ? /paddle/i.test(text)
    : /hayai/i.test(text);
}

function formatOcrPhaseLabel(
  job: JobWithProgress,
  suffix: "Downloading" | "Preparing" | "Running",
  t?: TFunction<"renderer">,
): string {
  const prefix = resolveOcrRendererKeyPrefix(job.ocrPipeline);
  const key = `job.phase.${prefix}${suffix}`;
  const action =
    suffix === "Downloading"
      ? "다운로드/설치 중"
      : suffix === "Preparing"
        ? "준비 중"
        : "분석 중";
  const engine = prefix === "hayaiOcr" ? "HayaiOCR" : "Paddle OCR";
  return translate(t, key, `${engine} ${action}`);
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
  "HayaiOCR 선분석 완료": "job.phase.hayaiOcrPreanalysisDone",
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
