import { shell } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PageImageExportChapterSelection,
  PageImageExportRequest,
  PageImageExportResult,
} from "../../shared/pageImageExportTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { listLibrary, openChapter } from "../library";
import { logError } from "../logger";
import { safeCleanup } from "../safeCleanup";
import {
  renderPageWithTranslationBlocksForExport,
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

type EmitJobEvent = EmitPageImageExportEvent;

type ResolvedExportPage = {
  page: MangaPage;
  pageIndex: number;
};

type ResolvedExportChapter = {
  chapter: ChapterSnapshot;
  chapterIndex: number;
  pages: ResolvedExportPage[];
};

type ResolvedPageImageExport = {
  workTitle: string;
  chapters: ResolvedExportChapter[];
  pageCount: number;
};

class PageImageExportAbortError extends DOMException {
  constructor(
    readonly completedPages: number,
    readonly totalPages: number,
  ) {
    super("Aborted", "AbortError");
  }
}

export async function runPageImageExportJob({
  context,
  request,
  outputParentDir,
  id,
  abortController,
  emit,
}: {
  context: InpaintingJobContext;
  request: PageImageExportRequest;
  outputParentDir: string;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
}): Promise<PageImageExportResult> {
  const resolved = await resolvePageImageExportSelection(request);
  emitExportStarting(id, emit, resolved.pageCount, resolved.chapters.length);

  const outputDir = await createPageImageExportOutputDir(
    outputParentDir,
    resolved.workTitle,
  );
  try {
    await writePageImageExportChapters({
      abortController,
      context,
      emit,
      id,
      outputDir,
      resolved,
    });
    throwIfAborted(abortController, resolved.pageCount, resolved.pageCount);
  } catch (error) {
    await safeCleanup("page-image-export-output", () =>
      rm(outputDir, { recursive: true, force: true }),
    );
    throw error;
  }
  emitExportCompleted(id, emit, resolved.pageCount, resolved.chapters.length);

  const openError = await openExportOutputDirectory(outputDir);
  return {
    outputDir,
    pageCount: resolved.pageCount,
    ...(openError ? { openError } : {}),
  };
}

async function resolvePageImageExportSelection(
  request: PageImageExportRequest,
): Promise<ResolvedPageImageExport> {
  const library = await listLibrary();
  const work = library.works.find(
    (candidate) => candidate.id === request.workId,
  );
  if (!work) {
    throw new Error(tMain("export.errors.workNotFound"));
  }

  const selections = validateUniqueChapterSelections(request.selections);
  const chapterSummaries = new Map(
    work.chapters.map((chapter) => [chapter.id, chapter]),
  );
  for (const chapterId of selections.keys()) {
    if (!chapterSummaries.has(chapterId)) {
      throw new Error(tMain("export.errors.chapterNotFound"));
    }
  }

  const chapters: ResolvedExportChapter[] = [];
  for (const [chapterIndex, chapterId] of work.chapterOrder.entries()) {
    const selection = selections.get(chapterId);
    if (!selection) {
      continue;
    }
    const chapter = await openChapter(chapterId);
    if (chapter.workId !== work.id) {
      throw new Error(tMain("export.errors.chapterNotFound"));
    }
    const pages = resolveChapterPages(chapter, selection);
    if (pages.length > 0) {
      chapters.push({ chapter, chapterIndex, pages });
    }
  }

  const pageCount = chapters.reduce(
    (total, chapter) => total + chapter.pages.length,
    0,
  );
  if (pageCount === 0) {
    throw new Error(tMain("export.noPages"));
  }
  return { workTitle: work.title, chapters, pageCount };
}

export function handlePageImageExportError({
  abortController,
  emit,
  error,
  id,
  request,
}: {
  abortController: AbortController;
  emit: EmitJobEvent;
  error: unknown;
  id: string;
  request: PageImageExportRequest;
}): never {
  if (isAbortError(error) || abortController.signal.aborted) {
    const progress = resolveAbortProgress(error);
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
    throw new Error(tMain("export.cancelled"), { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  logError("Page image export failed", { jobId: id, request, error });
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

function validateUniqueChapterSelections(
  selections: PageImageExportChapterSelection[],
): Map<string, PageImageExportChapterSelection> {
  const result = new Map<string, PageImageExportChapterSelection>();
  for (const selection of selections) {
    if (result.has(selection.chapterId)) {
      throw new Error(tMain("export.errors.duplicateChapter"));
    }
    result.set(selection.chapterId, selection);
  }
  return result;
}

function resolveChapterPages(
  chapter: ChapterSnapshot,
  selection: PageImageExportChapterSelection,
): ResolvedExportPage[] {
  if (selection.mode === "all") {
    return chapter.pages.map((page, pageIndex) => ({ page, pageIndex }));
  }

  const selectedPageIds = new Set<string>();
  for (const pageId of selection.pageIds) {
    if (selectedPageIds.has(pageId)) {
      throw new Error(tMain("export.errors.duplicatePage"));
    }
    selectedPageIds.add(pageId);
  }
  const knownPageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of selectedPageIds) {
    if (!knownPageIds.has(pageId)) {
      throw new Error(tMain("export.errors.pageNotFound"));
    }
  }
  return chapter.pages.flatMap((page, pageIndex) =>
    selectedPageIds.has(page.id) ? [{ page, pageIndex }] : [],
  );
}

async function createPageImageExportOutputDir(
  parentDir: string,
  workTitle: string,
): Promise<string> {
  const workName = sanitizeOutputPathSegment(workTitle, "work");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${workName}-${timestamp}`;
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const outputDir = join(
      parentDir,
      suffix === 1 ? baseName : `${baseName}-${suffix}`,
    );
    try {
      await mkdir(outputDir);
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
  context,
  emit,
  id,
  outputDir,
  resolved,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  resolved: ResolvedPageImageExport;
}): Promise<void> {
  let completedPages = 0;
  for (const entry of resolved.chapters) {
    const chapterDir = join(
      outputDir,
      `${formatOrder(entry.chapterIndex)}-${sanitizeOutputPathSegment(entry.chapter.title, "chapter")}`,
    );
    await mkdir(chapterDir, { recursive: true });

    for (const pageEntry of entry.pages) {
      throwIfAborted(abortController, completedPages, resolved.pageCount);
      emitExportPageProgress({
        id,
        emit,
        page: pageEntry.page,
        chapter: entry.chapter,
        completedPages,
        totalPages: resolved.pageCount,
        step: "running",
      });
      await writePageImageExportPage({
        abortController,
        completedPages,
        context,
        outputDir: chapterDir,
        page: pageEntry.page,
        pageIndex: pageEntry.pageIndex,
        totalPages: resolved.pageCount,
      });
      completedPages += 1;
      throwIfAborted(abortController, completedPages, resolved.pageCount);
      emitExportPageProgress({
        id,
        emit,
        page: pageEntry.page,
        chapter: entry.chapter,
        completedPages,
        totalPages: resolved.pageCount,
        step: "done",
      });
    }
  }
}

async function writePageImageExportPage({
  abortController,
  completedPages,
  context,
  outputDir,
  page,
  pageIndex,
  totalPages,
}: {
  abortController: AbortController;
  completedPages: number;
  context: InpaintingJobContext;
  outputDir: string;
  page: MangaPage;
  pageIndex: number;
  totalPages: number;
}): Promise<void> {
  const outputName = `${formatOrder(pageIndex)}-${sanitizeOutputBaseName(page.name)}.png`;
  const png = await renderPageWithTranslationBlocksForExport(page, {
    dataRoot: context.appPaths.dataRoot,
    decodeFallback: context.decodeImage,
  });
  throwIfAborted(abortController, completedPages, totalPages);
  await writeFile(join(outputDir, outputName), png);
  throwIfAborted(abortController, completedPages + 1, totalPages);
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

async function openExportOutputDirectory(outputDir: string): Promise<string> {
  try {
    return await shell.openPath(outputDir);
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
