import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type {
  JobEvent,
  MangaPage,
  RegionAnalysisRequest,
  RegionAnalysisResult,
  StartAnalysisRequest,
  StartAnalysisResult,
} from "../../shared/types";
import type { ImageDecodeFallback } from "../regionCrop";
import {
  createRegionCropPage,
  mapRegionBlocksToPageBlocks,
} from "../regionCrop";
import {
  finalizeRunningPages,
  getRunPaths,
  markChapterPagesRunning,
  openChapter,
  resolvePagesForRun,
  updatePageAfterAnalysis,
  updatePagesAfterAnalysis,
} from "../library";
import { logError } from "../logger";
import { runWholePagePipeline } from "../wholePagePipeline";
import type { ActiveJobStore } from "./activeJob";
import { emitJobEvent, isAbortError } from "./jobEvents";

export type TranslationJobContext = {
  jobs: ActiveJobStore;
  getMainWindow: () => BrowserWindow | null;
  decodeImage: ImageDecodeFallback;
};

export async function startAnalysisJob(
  context: TranslationJobContext,
  request: StartAnalysisRequest,
): Promise<StartAnalysisResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  context.jobs.start({ id, kind: "gemma-analysis", abortController });
  let resolved: Awaited<ReturnType<typeof resolvePagesForRun>> | null = null;
  let pageIds: string[] = [];
  let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;

  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    const requestedPageId =
      request.runMode === "single-page" ? request.pageId : undefined;
    resolved = await resolvePagesForRun(
      request.chapterId,
      request.runMode,
      requestedPageId,
    );
    if (resolved.pages.length === 0) {
      emit({
        id,
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역할 페이지가 없습니다.",
        phase: "done",
        progressCurrent: 0,
        progressTotal: 0,
        pageTotal: 0,
      });
      return {
        status: "completed",
        chapter: resolved.chapter,
        warnings: [],
      };
    }

    pageIds = resolved.pages.map((page) => page.id);
    const runningChapter = await markChapterPagesRunning(
      request.chapterId,
      pageIds,
    );
    const expectedUpdatedAtByPageId = new Map(
      runningChapter.pages
        .filter((page) => pageIds.includes(page.id))
        .map((page) => [page.id, page.updatedAt]),
    );
    runPaths = await getRunPaths(request.chapterId, id);
    const result = await runWholePagePipeline({
      jobId: id,
      emit,
      onCleanupReady: (cleanup) => {
        context.jobs.setCleanup(id, cleanup);
      },
      onPageComplete: async (page) => {
        await updatePageAfterAnalysis(
          request.chapterId,
          page,
          [],
          "completed",
          expectedUpdatedAtByPageId.get(page.id),
        );
      },
      onPagesComplete: async (pages) => {
        await updatePagesAfterAnalysis(
          request.chapterId,
          pages.map((page) => ({
            page,
            warnings: [],
            status: "completed" as const,
            expectedUpdatedAt: expectedUpdatedAtByPageId.get(page.id),
          })),
        );
      },
      onPageFailed: async (page, errorMessage) => {
        await updatePageAfterAnalysis(
          request.chapterId,
          page,
          [errorMessage],
          "failed",
          expectedUpdatedAtByPageId.get(page.id),
        );
      },
      pages: resolved.pages,
      runPaths,
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const failedPageCount = result.pages.filter(
      (page) => page.analysisStatus === "failed",
    ).length;
    if (failedPageCount === result.pages.length) {
      throw new Error(
        `번역 작업 실패: 모든 페이지가 실패했습니다. 마지막 오류는 각 페이지 상태와 로그를 확인하세요.`,
      );
    }

    emit({
      id,
      kind: "gemma-analysis",
      status: "completed",
      progressText:
        failedPageCount > 0
          ? `번역 완료 - ${failedPageCount}페이지 실패`
          : "번역 작업 완료",
      phase: "done",
      progressCurrent: resolved.pages.length,
      progressTotal: resolved.pages.length,
      pageTotal: resolved.pages.length,
    });

    return {
      status: "completed",
      chapter: await openChapter(request.chapterId),
      warnings: result.warnings,
    };
  } catch (error) {
    const lastEvent =
      context.jobs.current?.id === id
        ? context.jobs.current.lastEvent
        : undefined;
    if (isAbortError(error) || abortController.signal.aborted) {
      if (pageIds.length > 0) {
        await finalizeRunningPagesSafely(
          request.chapterId,
          pageIds,
          "idle",
          undefined,
          id,
        );
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
        attemptTotal: lastEvent?.attemptTotal,
      });
      return {
        status: "cancelled",
        chapter: await openChapter(request.chapterId).catch(
          () => resolved?.chapter,
        ),
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    if (pageIds.length > 0) {
      await finalizeRunningPagesSafely(
        request.chapterId,
        pageIds,
        "failed",
        message,
        id,
      );
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
      error,
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
      detail: message,
    });
    return {
      status: "failed",
      error: message,
      chapter: await openChapter(request.chapterId).catch(
        () => resolved?.chapter,
      ),
    };
  } finally {
    const job = context.jobs.current;
    if (job?.id === id) {
      await context.jobs.runCleanup(job, "job-finished");
      context.jobs.clearIfCurrent(id);
    }
  }
}

export async function translateRegionJob(
  context: TranslationJobContext,
  request: RegionAnalysisRequest,
): Promise<RegionAnalysisResult> {
  if (context.jobs.hasActive) {
    return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
  }

  const id = randomUUID();
  const abortController = new AbortController();
  let runPaths: Awaited<ReturnType<typeof getRunPaths>> | null = null;
  context.jobs.start({ id, kind: "gemma-analysis", abortController });
  let chapter: Awaited<ReturnType<typeof openChapter>> | null = null;

  const emit = (event: JobEvent) =>
    emitJobEvent(context.jobs, context.getMainWindow(), event);

  try {
    chapter = await openChapter(request.chapterId);
    const page = chapter.pages.find(
      (candidate) => candidate.id === request.pageId,
    );
    if (!page) {
      emit({
        id,
        kind: "gemma-analysis",
        status: "failed",
        progressText: "선택 영역 번역 실패",
        phase: "failed",
        detail: "선택한 페이지를 찾지 못했습니다.",
      });
      return {
        status: "failed",
        chapter,
        error: "선택한 페이지를 찾지 못했습니다.",
      };
    }
    const expectedUpdatedAt = page.updatedAt;
    runPaths = await getRunPaths(request.chapterId, id);
    const { cropPage, cropRect } = await createRegionCropPage(
      page,
      request.bbox,
      id,
      runPaths.runDir,
      context.decodeImage,
    );
    emit({
      id,
      kind: "gemma-analysis",
      status: "starting",
      progressText: "선택 영역 번역 준비 중",
      phase: "booting",
      progressCurrent: 0,
      progressTotal: 1,
      pageTotal: 1,
      detail: `${Math.round(cropRect.w)} x ${Math.round(cropRect.h)} px`,
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
      skipOcrPrepass: true,
    });

    if (abortController.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const analyzedCrop = result.pages[0];
    const mappedBlocks = analyzedCrop
      ? mapRegionBlocksToPageBlocks(analyzedCrop.blocks, page, cropRect)
      : [];
    const saved = await saveMappedRegionBlocks(
      request.chapterId,
      request.pageId,
      mappedBlocks,
      expectedUpdatedAt,
    );

    emit({
      id,
      kind: "gemma-analysis",
      status: "completed",
      progressText: "선택 영역 번역 완료",
      phase: "done",
      progressCurrent: 1,
      progressTotal: 1,
      pageTotal: 1,
      detail: `${mappedBlocks.length}개 블록`,
    });

    return {
      status: "completed",
      chapter: saved,
      warnings: result.warnings,
      pageId: request.pageId,
      blockIds: mappedBlocks.map((block) => block.id),
    };
  } catch (error) {
    const lastEvent =
      context.jobs.current?.id === id
        ? context.jobs.current.lastEvent
        : undefined;
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
        attemptTotal: lastEvent?.attemptTotal,
      });
      return {
        status: "cancelled",
        chapter: await openChapter(request.chapterId).catch(
          () => chapter ?? undefined,
        ),
        pageId: request.pageId,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    logError("Region translation job failed", {
      jobId: id,
      request,
      runPaths,
      lastEvent,
      error,
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
      detail: message,
    });
    return {
      status: "failed",
      error: message,
      chapter: await openChapter(request.chapterId).catch(
        () => chapter ?? undefined,
      ),
      pageId: request.pageId,
    };
  } finally {
    const job = context.jobs.current;
    if (job?.id === id) {
      await context.jobs.runCleanup(job, "region-job-finished");
      context.jobs.clearIfCurrent(id);
    }
  }
}

async function finalizeRunningPagesSafely(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage: string | undefined,
  jobId: string,
): Promise<void> {
  try {
    await finalizeRunningPages(chapterId, pageIds, status, errorMessage);
  } catch (error) {
    logError("Failed to finalize running pages after analysis job error", {
      jobId,
      chapterId,
      pageCount: pageIds.length,
      status,
      error,
    });
  }
}

async function saveMappedRegionBlocks(
  chapterId: string,
  pageId: string,
  mappedBlocks: MangaPage["blocks"],
  expectedUpdatedAt: string,
) {
  const latest = await openChapter(chapterId);
  const page = latest.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new Error("저장할 페이지를 찾지 못했습니다.");
  }
  if (page.updatedAt !== expectedUpdatedAt) {
    throw new Error(
      "선택 영역 번역 중 페이지가 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.",
    );
  }
  await updatePageAfterAnalysis(
    chapterId,
    { ...page, blocks: [...page.blocks, ...mappedBlocks] },
    [],
    "completed",
    expectedUpdatedAt,
  );
  return openChapter(chapterId);
}
