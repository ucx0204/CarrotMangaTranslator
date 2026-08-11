import { join } from "node:path";
import type {
  PageImageExportCancelledResult,
  PageImageExportCompletedResult,
  PageImageExportRequest,
} from "../../shared/pageImageExportTypes";
import type { PageImageExportFormat } from "../../shared/pageImageExportTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PageExportRenderSession } from "../pageExport";
import {
  formatPageImageExportOrder,
  sanitizeOutputBaseName,
  sanitizeOutputPathSegment,
} from "./pageImageExportNaming";
import { assertPageExportPngBuffer } from "../pageExportRasterSafety";
import { isAbortError } from "./jobEvents";
import type { InpaintingJobContext } from "./inpaintingJobTypes";
import { tMain } from "./localization";
import {
  emitExportCompleted,
  emitExportPageProgress,
  emitExportStarting,
  type EmitPageImageExportEvent,
} from "./pageImageExportJobEvents";
import {
  productionPageImageExportDependencies,
  type PageImageExportDependencies,
} from "./pageImageExportPorts";
import {
  resolvePageImageExportSelection,
  type ResolvedPageImageExport,
} from "./pageImageExportSelection";
import { writePagePsdExport } from "./pagePsdExportRunner";
import {
  createPageImageExportOutputDir,
  openExportOutputDirectory,
  removeFailedOutput,
} from "./pageImageExportOutput";

type EmitJobEvent = EmitPageImageExportEvent;

class PageImageExportAbortError extends DOMException {
  constructor(
    readonly completedPages: number,
    readonly totalPages: number,
  ) {
    super("Aborted", "AbortError");
  }
}

export type RunPageImageExportJobOptions = {
  context: InpaintingJobContext;
  request: PageImageExportRequest;
  outputParentDir: string;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
  dependencies?: PageImageExportDependencies;
};

export async function runPageImageExportJob({
  context,
  request,
  outputParentDir,
  id,
  abortController,
  emit,
  dependencies = productionPageImageExportDependencies,
}: RunPageImageExportJobOptions): Promise<PageImageExportCompletedResult> {
  throwIfAborted(abortController, 0, 0);
  const resolved = await resolvePageImageExportSelection(
    request,
    dependencies.repository,
  );
  assertTextlessExportReady(request, resolved);
  throwIfAborted(abortController, 0, resolved.pageCount);
  emitExportStarting(id, emit, resolved.pageCount, resolved.chapters.length);

  throwIfAborted(abortController, 0, resolved.pageCount);
  const outputDir = await createPageImageExportOutputDir(
    outputParentDir,
    resolved.workTitle,
    dependencies,
  );
  let renderSession: PageExportRenderSession | null = null;
  try {
    throwIfAborted(abortController, 0, resolved.pageCount);
    renderSession = await dependencies.renderer.createSession({
      dataRoot: context.appPaths.dataRoot,
      decodeFallback: context.decodeImage,
    });
    throwIfAborted(abortController, 0, resolved.pageCount);
    await writePageImageExportChapters({
      abortController,
      dependencies,
      emit,
      id,
      outputDir,
      renderSession,
      resolved,
      omitText: request.omitText === true,
      outputFormat: request.outputFormat ?? "png",
    });
    throwIfAborted(abortController, resolved.pageCount, resolved.pageCount);
  } catch (error) {
    await removeFailedOutput(outputDir, error, dependencies);
  } finally {
    renderSession?.close();
  }
  emitExportCompleted(id, emit, resolved.pageCount, resolved.chapters.length);

  throwIfAborted(abortController, resolved.pageCount, resolved.pageCount);
  const openError = await openExportOutputDirectory(outputDir, dependencies);
  return {
    status: "completed",
    outputDir,
    pageCount: resolved.pageCount,
    ...(openError ? { openError } : {}),
  };
}

export function handlePageImageExportError({
  abortController,
  emit,
  error,
  id,
  request,
  dependencies = productionPageImageExportDependencies,
}: {
  abortController: AbortController;
  emit: EmitJobEvent;
  error: unknown;
  id: string;
  request: PageImageExportRequest;
  dependencies?: PageImageExportDependencies;
}): PageImageExportCancelledResult {
  if (isAbortError(error) || abortController.signal.aborted) {
    const progress = resolveAbortProgress(error);
    emitCancelledExport({ id, emit, progress });
    return { status: "cancelled" };
  }

  const message = error instanceof Error ? error.message : String(error);
  dependencies.logger.error("Page image export failed", {
    jobId: id,
    request,
    error,
  });
  emit({
    id,
    kind: "page-export",
    status: "failed",
    progressText: tMain("export.failed"),
    phase: "failed",
    detail: message,
  });
  throw error;
}

function emitCancelledExport({
  id,
  emit,
  progress,
}: {
  id: string;
  emit: EmitJobEvent;
  progress: Pick<
    PageImageExportAbortError,
    "completedPages" | "totalPages"
  > | null;
}): void {
  emit({
    id,
    kind: "page-export",
    status: "cancelled",
    progressText: tMain("export.cancelled"),
    phase: "cancelled",
    ...(progress
      ? {
          progressCurrent: progress.completedPages,
          progressTotal: progress.totalPages,
          pageIndex: progress.completedPages,
          pageTotal: progress.totalPages,
        }
      : {}),
  });
}

async function writePageImageExportChapters({
  abortController,
  dependencies,
  emit,
  id,
  outputDir,
  renderSession,
  resolved,
  omitText,
  outputFormat,
}: {
  abortController: AbortController;
  dependencies: PageImageExportDependencies;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  renderSession: PageExportRenderSession;
  resolved: ResolvedPageImageExport;
  omitText: boolean;
  outputFormat: PageImageExportFormat;
}): Promise<void> {
  let completedPages = 0;
  for (const entry of resolved.chapters) {
    const chapterDir = join(
      outputDir,
      `${formatPageImageExportOrder(entry.chapterIndex)}-${sanitizeOutputPathSegment(entry.chapter.title, "chapter")}`,
    );
    await dependencies.runtime.createDirectory(chapterDir, true);
    completedPages = await writeChapterPages({
      abortController,
      chapter: entry.chapter,
      completedPages,
      dependencies,
      emit,
      id,
      outputDir: chapterDir,
      pages: entry.pages,
      renderSession,
      totalPages: resolved.pageCount,
      omitText,
      outputFormat,
    });
  }
}

async function writeChapterPages({
  abortController,
  chapter,
  completedPages: initialCompletedPages,
  dependencies,
  emit,
  id,
  outputDir,
  pages,
  renderSession,
  totalPages,
  omitText,
  outputFormat,
}: {
  abortController: AbortController;
  chapter: ChapterSnapshot;
  completedPages: number;
  dependencies: PageImageExportDependencies;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  pages: ResolvedPageImageExport["chapters"][number]["pages"];
  renderSession: PageExportRenderSession;
  totalPages: number;
  omitText: boolean;
  outputFormat: PageImageExportFormat;
}): Promise<number> {
  let completedPages = initialCompletedPages;
  for (const pageEntry of pages) {
    throwIfAborted(abortController, completedPages, totalPages);
    emitExportPageProgress({
      id,
      emit,
      page: pageEntry.page,
      chapter,
      completedPages,
      totalPages,
      step: "running",
    });
    await writePageImageExportPage({
      abortController,
      completedPages,
      dependencies,
      outputDir,
      page: pageEntry.page,
      pageIndex: pageEntry.pageIndex,
      renderSession,
      totalPages,
      omitText,
      outputFormat,
    });
    completedPages += 1;
    emitExportPageProgress({
      id,
      emit,
      page: pageEntry.page,
      chapter,
      completedPages,
      totalPages,
      step: "done",
    });
  }
  return completedPages;
}

async function writePageImageExportPage({
  abortController,
  completedPages,
  dependencies,
  outputDir,
  page,
  pageIndex,
  renderSession,
  totalPages,
  omitText,
  outputFormat,
}: {
  abortController: AbortController;
  completedPages: number;
  dependencies: PageImageExportDependencies;
  outputDir: string;
  page: MangaPage;
  pageIndex: number;
  renderSession: PageExportRenderSession;
  totalPages: number;
  omitText: boolean;
  outputFormat: PageImageExportFormat;
}): Promise<void> {
  const outputName = `${formatPageImageExportOrder(pageIndex)}-${sanitizeOutputBaseName(page.name)}.${outputFormat}`;
  if (outputFormat === "psd") {
    await writePagePsdExport({
      abortController,
      completedPages,
      dependencies,
      omitText,
      outputPath: join(outputDir, outputName),
      page,
      renderSession,
      throwIfAborted,
      totalPages,
    });
    return;
  }
  const png = await renderSession.renderPage(
    omitText ? { ...page, blocks: [] } : page,
  );
  throwIfAborted(abortController, completedPages, totalPages);
  assertPageExportPngBuffer(png, undefined, page.name);
  await dependencies.runtime.writePng(join(outputDir, outputName), png);
  throwIfAborted(abortController, completedPages + 1, totalPages);
}

function assertTextlessExportReady(
  request: PageImageExportRequest,
  resolved: ResolvedPageImageExport,
): void {
  if (!request.omitText) return;
  const missing = resolved.chapters
    .flatMap((entry) => entry.pages.map(({ page }) => page))
    .find((page) => !page.inpaintedImagePath);
  if (missing) {
    throw new Error(
      tMain("export.errors.inpaintedImageMissing", { name: missing.name }),
    );
  }
}

function throwIfAborted(
  abortController: AbortController,
  completedPages: number,
  totalPages: number,
): void {
  if (abortController.signal.aborted) {
    throw new PageImageExportAbortError(completedPages, totalPages);
  }
}

function resolveAbortProgress(
  error: unknown,
): Pick<PageImageExportAbortError, "completedPages" | "totalPages"> | null {
  return error instanceof PageImageExportAbortError ? error : null;
}
