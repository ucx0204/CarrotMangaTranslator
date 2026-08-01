import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { tMain } from "./localization";

type EmitJobEvent = (event: JobEvent) => void;

export type InpaintingProgressTarget = {
  targetType: "drawn" | "source";
  drawnPatternMode: boolean;
};

function resolveTargetLabel(
  targetType: InpaintingProgressTarget["targetType"],
): string {
  return tMain(`inpainting.targets.${targetType}`);
}

export function emitInpaintingStarting(
  id: string,
  emit: EmitJobEvent,
  pageCount: number,
  totalTargetBlocks: number,
  target: InpaintingProgressTarget,
): void {
  const targetLabel = resolveTargetLabel(target.targetType);
  emit({
    id,
    kind: "inpainting",
    status: "starting",
    progressText: tMain("inpainting.preparing", { target: targetLabel }),
    phase: "inpainting_preparing",
    progressCurrent: 0,
    progressTotal: pageCount,
    pageTotal: pageCount,
    detail: tMain("units.pagesAndBlocks", {
      pages: pageCount,
      blocks: totalTargetBlocks,
    }),
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
  const targetLabel = resolveTargetLabel(detail.target.targetType);
  emit({
    id,
    kind: "inpainting",
    status: "running",
    progressText: tMain("inpainting.pageRunning", {
      current: pageIndex + 1,
      total: pageCount,
      target: targetLabel,
    }),
    phase: "inpainting_running",
    progressCurrent: pageIndex + 1,
    progressTotal: pageCount,
    pageIndex: pageIndex + 1,
    pageTotal: pageCount,
    detail: detail.target.drawnPatternMode
      ? tMain("inpainting.drawnDetail", {
          page: page.name,
          count: detail.pageTargetCount,
        })
      : tMain("inpainting.blockDetail", {
          page: page.name,
          count: detail.pageTargetCount,
        }),
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
  const targetLabel = resolveTargetLabel(target.targetType);
  emit({
    id,
    kind: "inpainting",
    status: "running",
    progressText: tMain("inpainting.pageDone", {
      current: pageIndex + 1,
      total: pageCount,
      target: targetLabel,
    }),
    phase: "inpainting_done",
    progressCurrent: pageIndex + 1,
    progressTotal: pageCount,
    pageIndex: pageIndex + 1,
    pageTotal: pageCount,
    detail: tMain("units.blocks", { count: blocksErased }),
  });
}

export function emitInpaintingCompleted(
  id: string,
  emit: EmitJobEvent,
  pageCount: number,
  blocksErased: number,
  targetType: InpaintingProgressTarget["targetType"],
): void {
  const targetLabel = resolveTargetLabel(targetType);
  emit({
    id,
    kind: "inpainting",
    status: "completed",
    progressText: tMain("inpainting.completed", { target: targetLabel }),
    phase: "done",
    progressCurrent: pageCount,
    progressTotal: pageCount,
    pageTotal: pageCount,
    detail: tMain("units.pagesAndBlocks", {
      pages: pageCount,
      blocks: blocksErased,
    }),
  });
}

export function emitInpaintingPartial(
  id: string,
  emit: EmitJobEvent,
  pageCount: number,
  pagesIncomplete: number,
  blocksErased: number,
  blocksIncomplete: number,
  targetType: InpaintingProgressTarget["targetType"],
): void {
  const targetLabel = resolveTargetLabel(targetType);
  emit({
    id,
    kind: "inpainting",
    status: "partial",
    progressText: tMain("inpainting.partial", { target: targetLabel }),
    phase: "partial",
    progressCurrent: pageCount,
    progressTotal: pageCount,
    pageTotal: pageCount,
    detail: tMain("inpainting.partialDetail", {
      pages: pagesIncomplete,
      erased: blocksErased,
      incomplete: blocksIncomplete,
    }),
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
    progressText: tMain("inpainting.cancelled"),
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
    progressText: tMain("inpainting.failed"),
    phase: "failed",
    progressCurrent: lastEvent?.progressCurrent,
    progressTotal: lastEvent?.progressTotal,
    pageIndex: lastEvent?.pageIndex,
    pageTotal: lastEvent?.pageTotal,
    detail: message,
  });
}
