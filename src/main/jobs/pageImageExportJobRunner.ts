import { join } from "node:path";
import type {
  PageImageExportRequest,
  PageImageExportResult,
} from "../../shared/pageImageExportTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PageExportRenderSession } from "../pageExport";
import {
  sanitizeOutputBaseName,
  sanitizeOutputPathSegment,
} from "../pageExport";
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
}: RunPageImageExportJobOptions): Promise<PageImageExportResult> {
  const resolved = await resolvePageImageExportSelection(
    request,
    dependencies.repository,
  );
  emitExportStarting(id, emit, resolved.pageCount, resolved.chapters.length);

  const outputDir = await createPageImageExportOutputDir(
    outputParentDir,
    resolved.workTitle,
    dependencies,
  );
  let renderSession: PageExportRenderSession | null = null;
  try {
    renderSession = await dependencies.renderer.createSession({
      dataRoot: context.appPaths.dataRoot,
      decodeFallback: context.decodeImage,
    });
    await writePageImageExportChapters({
      abortController,
      dependencies,
      emit,
      id,
      outputDir,
      renderSession,
      resolved,
    });
    throwIfAborted(abortController, resolved.pageCount, resolved.pageCount);
  } catch (error) {
    await removeFailedOutput(outputDir, error, dependencies);
  } finally {
    renderSession?.close();
  }
  emitExportCompleted(id, emit, resolved.pageCount, resolved.chapters.length);

  const openError = await openExportOutputDirectory(outputDir, dependencies);
  return {
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
}): never {
  if (isAbortError(error) || abortController.signal.aborted) {
    const progress = resolveAbortProgress(error);
    emitCancelledExport({ id, emit, progress });
    throw new Error(tMain("export.cancelled"), { cause: error });
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

async function createPageImageExportOutputDir(
  parentDir: string,
  workTitle: string,
  dependencies: PageImageExportDependencies,
): Promise<string> {
  const workName = sanitizeOutputPathSegment(workTitle, "work");
  const baseName = `${workName}-${dependencies.runtime.createTimestamp()}`;
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const outputDir = join(
      parentDir,
      suffix === 1 ? baseName : `${baseName}-${suffix}`,
    );
    try {
      await dependencies.runtime.createDirectory(outputDir);
      return outputDir;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
  throw new Error(tMain("export.errors.outputDirectory"));
}

async function writePageImageExportChapters({
  abortController,
  dependencies,
  emit,
  id,
  outputDir,
  renderSession,
  resolved,
}: {
  abortController: AbortController;
  dependencies: PageImageExportDependencies;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  renderSession: PageExportRenderSession;
  resolved: ResolvedPageImageExport;
}): Promise<void> {
  let completedPages = 0;
  for (const entry of resolved.chapters) {
    const chapterDir = join(
      outputDir,
      `${formatOrder(entry.chapterIndex)}-${sanitizeOutputPathSegment(entry.chapter.title, "chapter")}`,
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
}: {
  abortController: AbortController;
  completedPages: number;
  dependencies: PageImageExportDependencies;
  outputDir: string;
  page: MangaPage;
  pageIndex: number;
  renderSession: PageExportRenderSession;
  totalPages: number;
}): Promise<void> {
  const outputName = `${formatOrder(pageIndex)}-${sanitizeOutputBaseName(page.name)}.png`;
  const png = await renderSession.renderPage(page);
  throwIfAborted(abortController, completedPages, totalPages);
  await dependencies.runtime.writePng(join(outputDir, outputName), png);
  throwIfAborted(abortController, completedPages + 1, totalPages);
}

async function removeFailedOutput(
  outputDir: string,
  operationError: unknown,
  dependencies: PageImageExportDependencies,
): Promise<never> {
  try {
    await dependencies.runtime.removeDirectory(outputDir);
  } catch (cleanupError) {
    dependencies.logger.error("Page image export cleanup failed", {
      outputDir,
      operationError,
      cleanupError,
    });
    throw new AggregateError(
      [operationError, cleanupError],
      "페이지 이미지 출력 정리에 실패했습니다.",
      { cause: cleanupError },
    );
  }
  throw operationError;
}

function formatOrder(index: number): string {
  return String(index + 1).padStart(3, "0");
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

async function openExportOutputDirectory(
  outputDir: string,
  dependencies: PageImageExportDependencies,
): Promise<string> {
  try {
    return await dependencies.runtime.openDirectory(outputDir);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
