import { clampBbox } from "../../../shared/geometry";
import type { BBox, JobEvent } from "../../../shared/types";

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
    h: Math.round(y2 - y1)
  });
}

export function reorderByTarget(currentOrder: string[], sourceId: string, targetId: string): string[] {
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

export function reorderRecordsByIdOrder<T extends { id: string }>(records: T[], order: string[]): T[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered = order.flatMap((id) => {
    const record = recordMap.get(id);
    return record ? [record] : [];
  });
  const orderedIds = new Set(ordered.map((record) => record.id));
  return [...ordered, ...records.filter((record) => !orderedIds.has(record.id))];
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"));
}

export function formatErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function resolveStatusLineReplacement(event: JobEvent): ((line: string) => boolean) | undefined {
  if (
    event.phase === "ocr_running" &&
    Number.isFinite(event.pageIndex) &&
    Number.isFinite(event.pageTotal) &&
    (event.pageTotal ?? 0) > 0
  ) {
    return (line) => /^\d+ \/ \d+ 페이지 Paddle OCR 분석 중$/.test(line) || line === "페이지 Paddle OCR 분석 중";
  }
  if (event.phase === "model_requesting" || event.phase === "page_running" || event.phase === "page_retry") {
    return (line) =>
      /^\d+ \/ \d+ 페이지 (AI 번역 요청 중|번역 중|재시도 \d+ \/ \d+)$/.test(line) ||
      /^페이지 (AI 번역 요청 중|번역 중|재시도 중)$/.test(line);
  }
  if (event.phase === "booting" || event.phase === "model_downloading" || event.phase === "ready") {
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
