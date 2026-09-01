import { clampBbox } from "../../../shared/geometry";
import type { BBox } from "../../../shared/textTypes";
import type { JobEvent, JobState } from "../../../shared/jobTypes";
import type { TFunction } from "i18next";

export type RegionSelectionState = {
  active: boolean;
  dragging: boolean;
  start: {
    x: number;
    y: number;
  };
  current: {
    x: number;
    y: number;
  };
};

export function regionSelectionToBbox(selection: RegionSelectionState): BBox {
  const x1 = Math.min(selection.start.x, selection.current.x);
  const y1 = Math.min(selection.start.y, selection.current.y);
  const x2 = Math.max(selection.start.x, selection.current.x);
  const y2 = Math.max(selection.start.y, selection.current.y);
  return clampBbox({
    x: Math.round(x1),
    y: Math.round(y1),
    w: Math.round(x2 - x1),
    h: Math.round(y2 - y1),
  });
}

export function reorderByTarget(
  currentOrder: string[],
  sourceId: string,
  targetId: string,
): string[] {
  const next = [...currentOrder];
  const sourceIndex = next.indexOf(sourceId);
  const targetIndex = next.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return currentOrder;
  }
  const [item] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, item);
  return next;
}

export function reorderRecordsByIdOrder<T extends { id: string }>(
  records: T[],
  order: string[],
): T[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered = order.flatMap((id) => {
    const record = recordMap.get(id);
    return record ? [record] : [];
  });
  const orderedIds = new Set(ordered.map((record) => record.id));
  return [
    ...ordered,
    ...records.filter((record) => !orderedIds.has(record.id)),
  ];
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']",
    ),
  );
}

export function formatElapsedDuration(
  elapsedMs: number | undefined,
  t?: TFunction<"renderer">,
): string | null {
  if (!Number.isFinite(elapsedMs) || (elapsedMs ?? -1) < 0) {
    return null;
  }
  if ((elapsedMs ?? 0) < 1000) {
    return translate(t, "job.elapsed.lessThanSecond", "1초 미만");
  }

  const totalSeconds = Math.max(1, Math.round((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return t
      ? t("job.elapsed.hoursMinutesSeconds", { hours, minutes, seconds })
      : `${hours}시간 ${minutes}분 ${seconds}초`;
  }
  if (minutes > 0) {
    return t
      ? t("job.elapsed.minutesSeconds", { minutes, seconds })
      : `${minutes}분 ${seconds}초`;
  }
  return t ? t("job.elapsed.seconds", { seconds }) : `${seconds}초`;
}

export function formatJobFailureGuidance(
  job: Pick<JobState, "failureGuidance">,
  t?: TFunction<"renderer">,
): string | null {
  switch (job.failureGuidance) {
    case "increase-max-output-tokens":
      return translate(
        t,
        "job.failureGuidance.maxOutputTokens",
        "최대 출력 토큰이 부족합니다. 설정 > LLM > 최대 출력 토큰을 늘려 주세요.",
      );
    case "increase-work-context-budget":
      return translate(
        t,
        "job.failureGuidance.workContextBudget",
        "작품 정보 예산이 부족합니다. 설정 > LLM > 작품 정보 예산을 늘려 주세요.",
      );
    case "increase-context-length":
      return translate(
        t,
        "job.failureGuidance.contextLength",
        "컨텍스트 길이가 부족합니다. 설정 > LLM > 컨텍스트 길이를 늘려 주세요. VRAM 사용량이 늘 수 있습니다.",
      );
    default:
      return null;
  }
}

export function fallbackJobLabelFromStatus(
  status: JobState["status"],
  t?: TFunction<"renderer">,
): string {
  switch (status) {
    case "starting":
      return translate(t, "job.status.starting", "모델 준비 중");
    case "running":
      return translate(t, "job.status.running", "작업 진행 중");
    case "cancelling":
      return translate(t, "job.status.cancelling", "작업 취소 중");
    case "cancelled":
      return translate(t, "job.status.cancelled", "작업이 취소됨");
    case "failed":
      return translate(t, "job.status.failed", "작업 실패");
    case "partial":
      return translate(t, "job.status.partial", "작업 부분 완료");
    case "completed":
      return translate(t, "job.status.completed", "번역 완료");
    default:
      return translate(t, "job.status.idle", "대기 중");
  }
}

export function resolveInstallLogLines(
  current: JobState,
  event: JobEvent,
  sameJob: boolean,
): string[] | undefined {
  if (event.installLogLine) {
    return [
      ...(sameJob ? (current.installLogLines ?? []) : []),
      event.installLogLine,
    ].slice(-80);
  }
  return sameJob ? current.installLogLines : undefined;
}

export function translate(
  t: TFunction<"renderer"> | undefined,
  key: string,
  fallback: string,
): string {
  return t ? t(key) : fallback;
}

export function resolveStatusLineReplacement(
  event: JobEvent,
  previousLine?: string,
): ((line: string) => boolean) | undefined {
  const legacyMatcher = resolveLegacyStatusLineReplacement(event);
  if (previousLine) {
    return (line) => line === previousLine || Boolean(legacyMatcher?.(line));
  }
  return legacyMatcher;
}

const OCR_PROGRESS_REPLACEMENT_PHASES = new Set<JobEvent["phase"]>([
  "ocr_preparing",
  "ocr_downloading",
  "ocr_running",
]);

const TRANSLATION_PROGRESS_REPLACEMENT_PHASES = new Set<JobEvent["phase"]>([
  "model_requesting",
  "page_running",
  "page_retry",
  "page_skipped",
]);

const MODEL_PREPARATION_REPLACEMENT_PHASES = new Set<JobEvent["phase"]>([
  "booting",
  "model_downloading",
  "ready",
]);

export function statusLineReplacementGroup(event: JobEvent): string | null {
  if (event.kind === "inpainting") {
    return "inpainting-progress";
  }
  if (event.kind === "page-export") {
    return "page-export-progress";
  }
  if (OCR_PROGRESS_REPLACEMENT_PHASES.has(event.phase)) {
    return "ocr-progress";
  }
  if (TRANSLATION_PROGRESS_REPLACEMENT_PHASES.has(event.phase)) {
    return "translation-progress";
  }
  if (event.phase === "page_done") {
    return "typography-progress";
  }
  if (MODEL_PREPARATION_REPLACEMENT_PHASES.has(event.phase)) {
    return "model-preparing";
  }
  return null;
}

function resolveLegacyStatusLineReplacement(
  event: JobEvent,
): ((line: string) => boolean) | undefined {
  const group = statusLineReplacementGroup(event);
  if (group === "ocr-progress") {
    return (line) =>
      line.includes("Paddle OCR") ||
      line.includes("HayaiOCR") ||
      line === "OCR 준비 중" ||
      line === "OCR 분석 중";
  }
  if (group === "translation-progress") {
    return (line) =>
      /^\d+ \/ \d+ 페이지 (AI 번역 요청 중|번역 중|재시도 \d+ \/ \d+|건너뜀)$/.test(
        line,
      ) || /^페이지 (AI 번역 요청 중|번역 중|재시도 중|건너뜀)$/.test(line);
  }
  if (group === "typography-progress") {
    return (line) =>
      /^\d+ \/ \d+ 페이지 (?:완료|글자·폰트 맞춤 중)$/.test(line) ||
      /^페이지 (?:완료|글자·폰트 맞춤 중)$/.test(line);
  }
  if (group === "inpainting-progress") {
    return (line) =>
      /^(?:원문|그린 영역) 지우기 (?:준비 중|완료|부분 완료)$/.test(line) ||
      /^\d+ \/ \d+ 페이지 (?:원문|그린 영역) (?:지우는 중|완료)$/.test(line) ||
      line === "인페인팅 작업이 취소되었습니다." ||
      line === "인페인팅 작업 실패";
  }
  if (group === "page-export-progress") {
    return (line) =>
      line === "페이지 출력 준비 중" ||
      line === "페이지 출력 완료" ||
      line === "페이지 출력이 취소되었습니다." ||
      line === "페이지 출력 실패" ||
      /^\d+ \/ \d+ 페이지 출력(?: 중| 완료)$/.test(line);
  }
  if (group === "model-preparing") {
    return (line) =>
      line === "모델 준비 중" ||
      line === "모델 준비 완료" ||
      line === "모델 다운로드/서버 준비 중" ||
      line === "Gemma 4 서버 시작 중" ||
      line === "Gemma 서버 시작 중" ||
      line === "Gemma 서버 준비 완료" ||
      line === "OpenAI Codex 엔드포인트 준비 중" ||
      line === "로컬 모델/서버 준비 중";
  }
  return undefined;
}
