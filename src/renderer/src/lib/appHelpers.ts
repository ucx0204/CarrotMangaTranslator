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

export function statusLineReplacementGroup(event: JobEvent): string | null {
  if (
    event.phase === "ocr_running" &&
    Number.isFinite(event.pageIndex) &&
    Number.isFinite(event.pageTotal) &&
    (event.pageTotal ?? 0) > 0
  ) {
    return "ocr-running";
  }
  if (
    event.phase === "model_requesting" ||
    event.phase === "page_running" ||
    event.phase === "page_retry"
  ) {
    return "page-running";
  }
  if (
    event.phase === "booting" ||
    event.phase === "model_downloading" ||
    event.phase === "ready"
  ) {
    return "model-preparing";
  }
  return null;
}

function resolveLegacyStatusLineReplacement(
  event: JobEvent,
): ((line: string) => boolean) | undefined {
  const group = statusLineReplacementGroup(event);
  if (group === "ocr-running") {
    return (line) =>
      /^\d+ \/ \d+ 페이지 Paddle OCR 분석 중$/.test(line) ||
      line === "페이지 Paddle OCR 분석 중";
  }
  if (group === "page-running") {
    return (line) =>
      /^\d+ \/ \d+ 페이지 (AI 번역 요청 중|번역 중|재시도 \d+ \/ \d+)$/.test(
        line,
      ) || /^페이지 (AI 번역 요청 중|번역 중|재시도 중)$/.test(line);
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
