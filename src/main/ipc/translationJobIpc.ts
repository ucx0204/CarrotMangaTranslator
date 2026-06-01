import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { StartAnalysisRequestSchema, RegionAnalysisRequestSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import type { JobEvent, MangaPage, RegionAnalysisResult, StartAnalysisResult } from "../../shared/types";
import {
  finalizeRunningPages,
  getRunPaths,
  markChapterPagesRunning,
  openChapter,
  resolvePagesForRun,
  saveChapterSnapshot,
  updatePageAfterAnalysis
} from "../library";
import { logError } from "../logger";
import { createRegionCropPage, mapRegionBlocksToPageBlocks } from "../regionCrop";
import { runWholePagePipeline } from "../wholePagePipeline";
import type { IpcContext } from "./context";
import { emitJobEvent, isAbortError } from "./jobEvents";

export function registerTranslationJobIpc(context: IpcContext): void {
  ipcMain.handle("job:start-analysis", async (_event, rawRequest: unknown): Promise<StartAnalysisResult> => {
    const request = parseIpcPayload(StartAnalysisRequestSchema, rawRequest, "번역 작업");
    if (context.jobs.hasActive) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    context.jobs.start({ id, kind: "gemma-analysis", abortController });
    let resolved: Awaited<ReturnType<typeof resolvePagesForRun>> | null = null;
    let pageIds: string[] = [];
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;

    const emit = (event: JobEvent) => emitJobEvent(context.jobs, context.getMainWindow(), event);

    try {
      resolved = await resolvePagesForRun(request.chapterId, request.runMode, request.pageId);
      if (resolved.pages.length === 0) {
        return {
          status: "completed",
          chapter: resolved.chapter,
          warnings: []
        };
      }

      pageIds = resolved.pages.map((page) => page.id);
      await markChapterPagesRunning(request.chapterId, pageIds);
      runPaths = await getRunPaths(request.chapterId, id);
      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          context.jobs.setCleanup(id, cleanup);
        },
        onPageComplete: async (page) => {
          await updatePageAfterAnalysis(request.chapterId, page, [], "completed");
        },
        onPageFailed: async (page, errorMessage) => {
          await updatePageAfterAnalysis(request.chapterId, page, [errorMessage], "failed");
        },
        pages: resolved.pages,
        runPaths,
        signal: abortController.signal
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역 작업 완료",
        phase: "done",
        progressCurrent: resolved.pages.length,
        progressTotal: resolved.pages.length,
        pageTotal: resolved.pages.length
      });

      return {
        status: "completed",
        chapter: await openChapter(request.chapterId),
        warnings: result.warnings
      };
    } catch (error) {
      const lastEvent = context.jobs.current?.id === id ? context.jobs.current.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        if (pageIds.length > 0) {
          await finalizeRunningPages(request.chapterId, pageIds, "idle");
        }
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId).catch(() => resolved?.chapter) };
      }

      const message = error instanceof Error ? error.message : String(error);
      if (pageIds.length > 0) {
        await finalizeRunningPages(request.chapterId, pageIds, "failed", message);
      }
      logError("Analysis job failed", {
        jobId: id,
        request,
        chapterId: request.chapterId,
        runMode: request.runMode,
        pageIds,
        resolvedPageCount: resolved?.pages.length,
        resolvedPageNames: resolved?.pages.map((page) => page.name),
        runPaths,
        lastEvent,
        error
      });
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId).catch(() => resolved?.chapter)
      };
    } finally {
      const job = context.jobs.current;
      if (job?.id === id) {
        await context.jobs.runCleanup(job, "job-finished");
        context.jobs.clearIfCurrent(id);
      }
    }
  });

  ipcMain.handle("job:translate-region", async (_event, rawRequest: unknown): Promise<RegionAnalysisResult> => {
    const request = parseIpcPayload(RegionAnalysisRequestSchema, rawRequest, "영역 번역");
    if (context.jobs.hasActive) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
    context.jobs.start({ id, kind: "gemma-analysis", abortController });
    let chapter: Awaited<ReturnType<typeof openChapter>> | null = null;

    const emit = (event: JobEvent) => emitJobEvent(context.jobs, context.getMainWindow(), event);

    try {
      chapter = await openChapter(request.chapterId);
      const page = chapter.pages.find((candidate) => candidate.id === request.pageId);
      if (!page) {
        return { status: "failed", chapter, error: "선택한 페이지를 찾지 못했습니다." };
      }
      runPaths = await getRunPaths(request.chapterId, id);
      const { cropPage, cropRect } = await createRegionCropPage(page, request.bbox, id, runPaths.runDir, context.decodeImage);
      emit({
        id,
        kind: "gemma-analysis",
        status: "starting",
        progressText: "선택 영역 번역 준비 중",
        phase: "booting",
        progressCurrent: 0,
        progressTotal: 1,
        pageTotal: 1,
        detail: `${Math.round(cropRect.w)} x ${Math.round(cropRect.h)} px`
      });

      const result = await runWholePagePipeline({
        jobId: id,
        emit,
        onCleanupReady: (cleanup) => {
          context.jobs.setCleanup(id, cleanup);
        },
        pages: [cropPage],
        runPaths,
        signal: abortController.signal,
        skipOcrPrepass: true
      });

      if (abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const analyzedCrop = result.pages[0];
      const mappedBlocks = analyzedCrop ? mapRegionBlocksToPageBlocks(analyzedCrop.blocks, page, cropRect) : [];
      const saved = await saveMappedRegionBlocks(request.chapterId, request.pageId, mappedBlocks);

      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "선택 영역 번역 완료",
        phase: "done",
        progressCurrent: 1,
        progressTotal: 1,
        pageTotal: 1,
        detail: `${mappedBlocks.length}개 블록`
      });

      return {
        status: "completed",
        chapter: saved,
        warnings: result.warnings,
        pageId: request.pageId,
        blockIds: mappedBlocks.map((block) => block.id)
      };
    } catch (error) {
      const lastEvent = context.jobs.current?.id === id ? context.jobs.current.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal,
          attempt: lastEvent?.attempt,
          attemptTotal: lastEvent?.attemptTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId).catch(() => chapter ?? undefined), pageId: request.pageId };
      }

      const message = error instanceof Error ? error.message : String(error);
      logError("Region translation job failed", {
        jobId: id,
        request,
        runPaths,
        lastEvent,
        error
      });
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "작업 실패",
        phase: "failed",
        progressCurrent: lastEvent?.progressCurrent,
        progressTotal: lastEvent?.progressTotal,
        pageIndex: lastEvent?.pageIndex,
        pageTotal: lastEvent?.pageTotal,
        attempt: lastEvent?.attempt,
        attemptTotal: lastEvent?.attemptTotal,
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId).catch(() => chapter ?? undefined),
        pageId: request.pageId
      };
    } finally {
      const job = context.jobs.current;
      if (job?.id === id) {
        await context.jobs.runCleanup(job, "region-job-finished");
        context.jobs.clearIfCurrent(id);
      }
    }
  });
}

async function saveMappedRegionBlocks(chapterId: string, pageId: string, mappedBlocks: MangaPage["blocks"]) {
  const latest = await openChapter(chapterId);
  const now = new Date().toISOString();
  const nextChapter: typeof latest = {
    ...latest,
    pages: latest.pages.map((candidate) =>
      candidate.id === pageId
        ? {
            ...candidate,
            blocks: [...candidate.blocks, ...mappedBlocks],
            analysisStatus: "completed",
            lastError: undefined,
            updatedAt: now
          }
        : candidate
    ),
    updatedAt: now
  };
  return saveChapterSnapshot(nextChapter);
}
