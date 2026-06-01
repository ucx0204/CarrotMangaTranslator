import { ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  InpaintingColorSampleRequestSchema,
  InpaintingExportRequestSchema,
  InpaintingRetouchRequestSchema,
  InpaintingRevertRequestSchema,
  StartInpaintingRequestSchema,
  parseIpcPayload
} from "../../shared/ipcSchemas";
import type {
  InpaintingColorSampleResult,
  InpaintingExportResult,
  InpaintingRetouchResult,
  InpaintingRevertResult,
  JobEvent,
  MangaPage,
  StartInpaintingResult
} from "../../shared/types";
import {
  applyInpaintingRetouch,
  inpaintDrawnPatternPage,
  inpaintPatternPage,
  prepareFluxInpaintingEngine,
  sampleImageColor,
  type FluxInpaintingEngine
} from "../inpainting";
import { assertLibraryImagePath, openChapter, updatePagesAfterInpainting } from "../library";
import { logError } from "../logger";
import { renderPageWithTranslationBlocksForExport, sanitizeOutputBaseName } from "../pageExport";
import type { IpcContext } from "./context";
import { emitJobEvent, isAbortError } from "./jobEvents";

export function registerInpaintingIpc(context: IpcContext): void {
  ipcMain.handle("job:start-inpainting", async (_event, rawRequest: unknown): Promise<StartInpaintingResult> => {
    const request = parseIpcPayload(StartInpaintingRequestSchema, rawRequest, "인페인팅 작업");
    if (context.jobs.hasActive) {
      return { status: "failed", error: "이미 실행 중인 작업이 있습니다." };
    }

    const chapter = await openChapter(request.chapterId);
    const drawnPatternMode = request.mode === "page-pattern-drawn";
    const drawnStrokes = request.mode === "page-pattern-drawn" ? request.strokes : [];
    const drawnFeatherPx = request.mode === "page-pattern-drawn" ? request.featherPx : undefined;
    const targetLabel = drawnPatternMode ? "그린 영역" : "무늬 배경";
    const pages = "pageId" in request ? chapter.pages.filter((page) => page.id === request.pageId) : chapter.pages;

    if (pages.length === 0) {
      return { status: "failed", chapter, error: "인페인팅할 페이지를 찾지 못했습니다." };
    }

    const id = randomUUID();
    const abortController = new AbortController();
    context.jobs.start({ id, kind: "inpainting", abortController });
    let fluxEngine: FluxInpaintingEngine | null = null;

    const emit = (event: JobEvent) => emitJobEvent(context.jobs, context.getMainWindow(), event);

    try {
      const totalTargetBlocks = drawnPatternMode ? drawnStrokes.length : pages.reduce((count, page) => count + page.blocks.length, 0);
      emit({
        id,
        kind: "inpainting",
        status: "starting",
        progressText: `${targetLabel} 지우기 준비 중`,
        phase: "inpainting_preparing",
        progressCurrent: 0,
        progressTotal: pages.length,
        pageTotal: pages.length,
        detail: `${pages.length}페이지, ${totalTargetBlocks}개 블록`
      });

      let blocksErased = 0;
      const changedPages: MangaPage[] = [];
      if (totalTargetBlocks > 0) {
        fluxEngine = await prepareFluxInpaintingEngine({
          runtimeDir: join(context.appPaths.dataRoot, "models", "inpainting", "mgt-flux-klein-runtime"),
          modelDir: join(context.appPaths.dataRoot, "models", "inpainting", "flux-klein-4b"),
          signal: abortController.signal,
          onProgress: (progress) =>
            emit({
              id,
              kind: "inpainting",
              status: "starting",
              progressText: progress.progressText,
              phase: "model_downloading",
              progressCurrent: 0,
              progressTotal: pages.length,
              pageTotal: pages.length,
              detail: progress.detail,
              progressMode: progress.progressMode,
              progressPercent: progress.progressPercent,
              progressBytes: progress.progressBytes,
              progressTotalBytes: progress.progressTotalBytes,
              installLogLine: progress.installLogLine
            })
        });
      }
      for (const [pageIndex, page] of pages.entries()) {
        if (abortController.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        const pageTargetCount = drawnPatternMode ? drawnStrokes.length : page.blocks.length;
        emit({
          id,
          kind: "inpainting",
          status: "running",
          progressText: `${pageIndex + 1} / ${pages.length} 페이지 ${targetLabel} 지우는 중`,
          phase: "inpainting_running",
          progressCurrent: pageIndex + 1,
          progressTotal: pages.length,
          pageIndex: pageIndex + 1,
          pageTotal: pages.length,
          detail: `${page.name} · ${pageTargetCount}${drawnPatternMode ? "개 그린 영역" : "개 블록"}`
        });

        const result = drawnPatternMode
          ? await inpaintDrawnPatternPage(page, {
              signal: abortController.signal,
              decodeFallback: context.decodeImage,
              fluxEngine: fluxEngine ?? undefined,
              strokes: drawnStrokes,
              featherPx: drawnFeatherPx
            })
          : await inpaintPatternPage(page, {
              signal: abortController.signal,
              decodeFallback: context.decodeImage,
              fluxEngine: fluxEngine ?? undefined
            });
        if (result.blocksErased > 0) {
          changedPages.push(result.page);
          blocksErased += result.blocksErased;
        }

        emit({
          id,
          kind: "inpainting",
          status: "running",
          progressText: `${pageIndex + 1} / ${pages.length} 페이지 ${targetLabel} 완료`,
          phase: "inpainting_done",
          progressCurrent: pageIndex + 1,
          progressTotal: pages.length,
          pageIndex: pageIndex + 1,
          pageTotal: pages.length,
          detail: `${result.blocksErased}개 블록`
        });
      }

      const saved = changedPages.length > 0 ? await updatePagesAfterInpainting(request.chapterId, changedPages) : await openChapter(request.chapterId);
      emit({
        id,
        kind: "inpainting",
        status: "completed",
        progressText: `${targetLabel} 지우기 완료`,
        phase: "done",
        progressCurrent: pages.length,
        progressTotal: pages.length,
        pageTotal: pages.length,
        detail: `${pages.length}페이지, ${blocksErased}개 블록`
      });

      return {
        status: "completed",
        chapter: saved,
        pagesChanged: changedPages.length,
        blocksErased
      };
    } catch (error) {
      const lastEvent = context.jobs.current?.id === id ? context.jobs.current.lastEvent : undefined;
      if (isAbortError(error) || abortController.signal.aborted) {
        emit({
          id,
          kind: "inpainting",
          status: "cancelled",
          progressText: "인페인팅 작업이 취소되었습니다.",
          phase: "cancelled",
          progressCurrent: lastEvent?.progressCurrent,
          progressTotal: lastEvent?.progressTotal,
          pageIndex: lastEvent?.pageIndex,
          pageTotal: lastEvent?.pageTotal
        });
        return { status: "cancelled", chapter: await openChapter(request.chapterId) };
      }

      const message = error instanceof Error ? error.message : String(error);
      logError("Inpainting job failed", { jobId: id, request, lastEvent, error });
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
        detail: message
      });
      return {
        status: "failed",
        error: message,
        chapter: await openChapter(request.chapterId)
      };
    } finally {
      if (fluxEngine) {
        await fluxEngine.dispose().catch((error) => logError("Failed to dispose Flux inpainting session", { error }));
      }
      context.jobs.clearIfCurrent(id);
    }
  });

  ipcMain.handle("inpainting:apply-retouch", async (_event, rawRequest: unknown): Promise<InpaintingRetouchResult> => {
    const request = parseIpcPayload(InpaintingRetouchRequestSchema, rawRequest, "인페인팅 보정");
    const chapter = await openChapter(request.chapterId);
    const page = chapter.pages.find((candidate) => candidate.id === request.pageId);
    if (!page) {
      throw new Error("리터치할 페이지를 찾지 못했습니다.");
    }
    const nextPage = await applyInpaintingRetouch(page, {
      mode: request.mode,
      points: request.points,
      radiusPx: request.radiusPx,
      color: request.color,
      decodeFallback: context.decodeImage
    });
    const saved = await updatePagesAfterInpainting(request.chapterId, [nextPage]);
    return {
      chapter: saved,
      pageId: request.pageId
    };
  });

  ipcMain.handle("inpainting:revert", async (_event, rawRequest: unknown): Promise<InpaintingRevertResult> => {
    const request = parseIpcPayload(InpaintingRevertRequestSchema, rawRequest, "인페인팅 되돌리기");
    const chapter = await openChapter(request.chapterId);
    const pages =
      request.scope === "page"
        ? chapter.pages.filter((page) => page.id === request.pageId && page.inpaintedImagePath)
        : chapter.pages.filter((page) => page.inpaintedImagePath);
    if (pages.length === 0) {
      return {
        chapter,
        pagesChanged: 0
      };
    }
    const reverted = pages.map((page) => ({
      ...page,
      inpaintedImagePath: undefined,
      updatedAt: new Date().toISOString()
    }));
    const saved = await updatePagesAfterInpainting(request.chapterId, reverted);
    return {
      chapter: saved,
      pagesChanged: reverted.length
    };
  });

  ipcMain.handle("inpainting:sample-color", async (_event, rawRequest: unknown): Promise<InpaintingColorSampleResult> => {
    const request = parseIpcPayload(InpaintingColorSampleRequestSchema, rawRequest, "색상 샘플");
    const imagePath = assertLibraryImagePath(request.imagePath);
    return {
      color: await sampleImageColor(imagePath, request.x, request.y, context.decodeImage)
    };
  });

  ipcMain.handle("inpainting:export-results", async (_event, rawRequest: unknown): Promise<InpaintingExportResult> => {
    const request = parseIpcPayload(InpaintingExportRequestSchema, rawRequest, "결과 출력");
    const chapter = await openChapter(request.chapterId);
    if (chapter.pages.length === 0) {
      throw new Error("출력할 페이지가 없습니다.");
    }

    const firstPageDir = dirname(chapter.pages[0].imagePath);
    const chapterDir = dirname(firstPageDir);
    const outputDir = join(chapterDir, "processed", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(outputDir, { recursive: true });

    for (const [index, page] of chapter.pages.entries()) {
      const outputName = `${String(index + 1).padStart(3, "0")}-${sanitizeOutputBaseName(page.name)}.png`;
      const png = await renderPageWithTranslationBlocksForExport(page, {
        dataRoot: context.appPaths.dataRoot,
        decodeFallback: context.decodeImage
      });
      await writeFile(join(outputDir, outputName), png);
    }

    await shell.openPath(outputDir);
    return {
      outputDir,
      pageCount: chapter.pages.length
    };
  });
}
