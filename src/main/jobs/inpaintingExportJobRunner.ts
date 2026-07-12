import { shell } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  InpaintingExportRequest,
  InpaintingExportResult,
} from "../../shared/inpaintingTypes";
import type { JobEvent } from "../../shared/jobTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { openChapter } from "../library";
import { logError } from "../logger";
import { tMain } from "./localization";
import {
  renderPageWithTranslationBlocksForExport,
  sanitizeOutputBaseName,
} from "../pageExport";
import { isAbortError } from "./jobEvents";
import type { InpaintingJobContext } from "./inpaintingJobTypes";

type EmitJobEvent = (event: JobEvent) => void;

export async function runInpaintingExportJob({
  context,
  request,
  id,
  abortController,
  emit,
}: {
  context: InpaintingJobContext;
  request: InpaintingExportRequest;
  id: string;
  abortController: AbortController;
  emit: EmitJobEvent;
}): Promise<InpaintingExportResult> {
  const chapter = await openChapter(request.chapterId);
  const pages =
    request.scope === "page"
      ? chapter.pages.filter((page) => page.id === request.pageId)
      : chapter.pages;
  if (pages.length === 0) {
    throw new Error(tMain("export.noPages"));
  }

  emitExportStarting(id, emit, pages.length, request.scope);
  const outputDir = await createInpaintingExportOutputDir(pages[0]);
  await writeInpaintingExportPages({
    abortController,
    context,
    emit,
    id,
    outputDir,
    pages,
  });
  emitExportCompleted(id, emit, pages.length, request.scope);
  const openError = await shell.openPath(outputDir);
  return {
    outputDir,
    pageCount: pages.length,
    ...(openError ? { openError } : {}),
  };
}

export function handleInpaintingExportError({
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
  request: InpaintingExportRequest;
}): never {
  if (isAbortError(error) || abortController.signal.aborted) {
    emit({
      id,
      kind: "inpainting",
      status: "cancelled",
      progressText: tMain("export.cancelled"),
      phase: "cancelled",
    });
    throw new Error(tMain("export.cancelled"), { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  logError("Inpainting export failed", { jobId: id, request, error });
  emit({
    id,
    kind: "inpainting",
    status: "failed",
    progressText: tMain("export.failed"),
    phase: "failed",
    detail: message,
  });
  throw error;
}

function emitExportStarting(
  id: string,
  emit: EmitJobEvent,
  totalPages: number,
  scope: InpaintingExportRequest["scope"],
): void {
  emit({
    id,
    kind: "inpainting",
    status: "starting",
    progressText: tMain("export.preparing"),
    phase: "finalizing",
    progressCurrent: 0,
    progressTotal: totalPages,
    pageTotal: totalPages,
    detail: formatExportScopeDetail(scope, totalPages),
  });
}

async function createInpaintingExportOutputDir(
  firstPage: MangaPage,
): Promise<string> {
  const firstPageDir = dirname(firstPage.imagePath);
  const chapterDir = dirname(firstPageDir);
  const outputDir = join(
    chapterDir,
    "processed",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(outputDir, { recursive: true });
  return outputDir;
}

async function writeInpaintingExportPages({
  abortController,
  context,
  emit,
  id,
  outputDir,
  pages,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  pages: MangaPage[];
}): Promise<void> {
  for (const [index, page] of pages.entries()) {
    if (abortController.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    emitExportPageProgress(
      id,
      emit,
      page,
      index,
      pages.length,
      "running",
      false,
    );
    await writeInpaintingExportPage(context, outputDir, page, index);
    emitExportPageProgress(id, emit, page, index, pages.length, "done", true);
  }
}

async function writeInpaintingExportPage(
  context: InpaintingJobContext,
  outputDir: string,
  page: MangaPage,
  index: number,
): Promise<void> {
  const outputName = `${String(index + 1).padStart(3, "0")}-${sanitizeOutputBaseName(page.name)}.png`;
  const png = await renderPageWithTranslationBlocksForExport(page, {
    dataRoot: context.appPaths.dataRoot,
    decodeFallback: context.decodeImage,
  });
  await writeFile(join(outputDir, outputName), png);
}

function emitExportPageProgress(
  id: string,
  emit: EmitJobEvent,
  page: MangaPage,
  index: number,
  totalPages: number,
  step: "running" | "done",
  completed: boolean,
): void {
  emit({
    id,
    kind: "inpainting",
    status: "running",
    progressText: tMain(`export.page.${step}`, {
      current: index + 1,
      total: totalPages,
    }),
    phase: "finalizing",
    progressCurrent: completed ? index + 1 : index,
    progressTotal: totalPages,
    pageIndex: index + 1,
    pageTotal: totalPages,
    detail: page.name,
  });
}

function emitExportCompleted(
  id: string,
  emit: EmitJobEvent,
  totalPages: number,
  scope: InpaintingExportRequest["scope"],
): void {
  emit({
    id,
    kind: "inpainting",
    status: "completed",
    progressText: tMain("export.completed"),
    phase: "done",
    progressCurrent: totalPages,
    progressTotal: totalPages,
    pageTotal: totalPages,
    detail: formatExportScopeDetail(scope, totalPages),
  });
}

function formatExportScopeDetail(
  scope: InpaintingExportRequest["scope"],
  totalPages: number,
): string {
  return tMain(`export.scope.${scope}`, { count: totalPages });
}
