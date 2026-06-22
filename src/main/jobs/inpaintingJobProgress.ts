import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";

type EmitJobEvent = (event: JobEvent) => void;

export type InpaintingProgressTarget = {
  targetLabel: string;
  drawnPatternMode: boolean;
};

export function emitInpaintingStarting(
  id: string,
  emit: EmitJobEvent,
  pageCount: number,
  totalTargetBlocks: number,
  target: InpaintingProgressTarget,
): void {
  emit({
    id,
    kind: "inpainting",
    status: "starting",
    progressText: `${target.targetLabel} 지우기 준비 중`,
    phase: "inpainting_preparing",
    progressCurrent: 0,
    progressTotal: pageCount,
    pageTotal: pageCount,
    detail: `${pageCount}페이지, ${totalTargetBlocks}개 블록`,
  });
}

export function emitInpaintingPageRunning(
  id: string,
  emit: EmitJobEvent,
  page: MangaPage,
  pageIndex: number,
  pageCount: number,
  detail: {
    pageTargetCount: number;
    target: InpaintingProgressTarget;
  },
): void {
  emit({
    id,
    kind: "inpainting",
    status: "running",
    progressText: `${pageIndex + 1} / ${pageCount} 페이지 ${detail.target.targetLabel} 지우는 중`,
    phase: "inpainting_running",
    progressCurrent: pageIndex + 1,
    progressTotal: pageCount,
    pageIndex: pageIndex + 1,
    pageTotal: pageCount,
    detail: `${page.name} · ${detail.pageTargetCount}${detail.target.drawnPatternMode ? "개 그린 영역" : "개 블록"}`,
  });
}

export function emitInpaintingPageDone(
  id: string,
  emit: EmitJobEvent,
  pageIndex: number,
  pageCount: number,
  target: InpaintingProgressTarget,
  blocksErased: number,
): void {
  emit({
    id,
    kind: "inpainting",
    status: "running",
    progressText: `${pageIndex + 1} / ${pageCount} 페이지 ${target.targetLabel} 완료`,
    phase: "inpainting_done",
    progressCurrent: pageIndex + 1,
    progressTotal: pageCount,
    pageIndex: pageIndex + 1,
    pageTotal: pageCount,
    detail: `${blocksErased}개 블록`,
  });
}

export function emitInpaintingCompleted(
  id: string,
  emit: EmitJobEvent,
  pageCount: number,
  blocksErased: number,
  targetLabel: string,
): void {
  emit({
    id,
    kind: "inpainting",
    status: "completed",
    progressText: `${targetLabel} 지우기 완료`,
    phase: "done",
    progressCurrent: pageCount,
    progressTotal: pageCount,
    pageTotal: pageCount,
    detail: `${pageCount}페이지, ${blocksErased}개 블록`,
  });
}

export function emitInpaintingCancelled(
  id: string,
  emit: EmitJobEvent,
  lastEvent: JobEvent | undefined,
): void {
  emit({
    id,
    kind: "inpainting",
    status: "cancelled",
    progressText: "인페인팅 작업이 취소되었습니다.",
    phase: "cancelled",
    progressCurrent: lastEvent?.progressCurrent,
    progressTotal: lastEvent?.progressTotal,
    pageIndex: lastEvent?.pageIndex,
    pageTotal: lastEvent?.pageTotal,
  });
}

export function emitInpaintingFailed(
  id: string,
  emit: EmitJobEvent,
  lastEvent: JobEvent | undefined,
  message: string,
): void {
  emit({
    id,
    kind: "inpainting",
    status: "failed",
    progressText: "인페인팅 작업 실패",
    phase: "failed",
    progressCurrent: lastEvent?.progressCurrent,
    progressTotal: lastEvent?.progressTotal,
    pageIndex: lastEvent?.pageIndex,
    pageTotal: lastEvent?.pageTotal,
    detail: message,
  });
}
