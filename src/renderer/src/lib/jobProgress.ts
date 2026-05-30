import type { JobEvent, JobState } from "../../../shared/types";

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

export function formatJobLabel(job: JobWithProgress): string {
  switch (job.phase) {
    case "booting":
      return job.progressText?.trim() || "모델 준비 중";
    case "model_downloading":
      return job.progressText?.trim() || "모델 다운로드/서버 준비 중";
    case "ocr_preparing":
      return formatPageLabel(job, "Paddle OCR 준비 중");
    case "ocr_downloading":
      return "Paddle OCR 다운로드/설치 중";
    case "ocr_running":
      if (!hasPageIndex(job)) {
        return job.progressText?.trim() || "Paddle OCR 분석 중";
      }
      return formatPageLabel(job, "Paddle OCR 분석 중");
    case "model_requesting":
      return formatPageLabel(job, "AI 번역 요청 중");
    case "ready":
      return "모델 준비 완료";
    case "page_running":
      return formatPageLabel(job, "번역 중");
    case "page_retry":
      return formatRetryLabel(job);
    case "page_done":
      return formatPageLabel(job, "완료");
    case "page_skipped":
      return formatPageLabel(job, "건너뜀");
    case "inpainting_preparing":
      return job.progressText?.trim() || "인페인팅 준비 중";
    case "inpainting_running":
      return job.progressText?.trim() || formatPageLabel(job, "단색 배경 지우는 중");
    case "inpainting_done":
      return job.progressText?.trim() || formatPageLabel(job, "단색 배경 완료");
    case "finalizing":
      return "결과 정리 중";
    case "done":
      return job.progressText?.trim() || "작업 완료";
    case "cancelled":
      return "작업이 취소됨";
    case "failed":
      return "작업 실패";
    default:
      return fallbackFromStatus(job.status);
  }
}

export function formatJobEventLine(event: JobEvent): string {
  return formatJobLabel(event);
}

export function resolveProgressSnapshot(job: JobWithProgress): ProgressSnapshot | null {
  if (job.progressMode === "log-only") {
    return { mode: "log-only" };
  }

  if (job.progressMode === "indeterminate") {
    return { mode: "indeterminate" };
  }

  if ((job.progressMode === "determinate" || job.progressMode === undefined) && Number.isFinite(job.progressPercent)) {
    const ratio = Math.max(0, Math.min(1, Number(job.progressPercent)));
    return {
      mode: "determinate",
      current: Math.round(ratio * 100),
      total: 100,
      ratio
    };
  }

  if (job.progressMode === "determinate") {
    return null;
  }

  if (job.phase === "booting" || job.phase === "model_downloading") {
    return { mode: "indeterminate" };
  }

  if (!Number.isFinite(job.progressCurrent) || !Number.isFinite(job.progressTotal) || (job.progressTotal ?? 0) <= 0) {
    return null;
  }

  const total = Math.max(1, Math.floor(job.progressTotal ?? 0));
  const current = Math.min(total, Math.max(0, Math.floor(job.progressCurrent ?? 0)));
  return {
    mode: "determinate",
    current,
    total,
    ratio: current / total
  };
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

  const skipped = warnings.filter((warning) => warning.includes("건너뜁니다")).length;
  const uncertain = warnings.filter((warning) => warning.includes("불확실한 OCR")).length;
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

function hasPageIndex(job: JobWithProgress): boolean {
  return Number.isFinite(job.pageIndex) && Number.isFinite(job.pageTotal) && (job.pageTotal ?? 0) > 0;
}

function formatRetryLabel(job: JobWithProgress): string {
  if (Number.isFinite(job.pageIndex) && Number.isFinite(job.pageTotal) && Number.isFinite(job.attempt) && Number.isFinite(job.attemptTotal)) {
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
