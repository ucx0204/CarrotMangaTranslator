/* eslint-disable max-lines -- progress, raster/PSD writing, collision checks, and cancellation form one export transaction */
import type {
  PageImageExportCancelledResult,
  PageImageExportCompletedResult,
  PageExportSelectionRequest,
} from "../../shared/pageImageExportTypes";
import { dirname, extname, join } from "node:path";
import type { PageImageExportFormat } from "../../shared/pageImageExportTypes";
import {
  MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
  ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
} from "../../shared/pageExportLimits";
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
import {
  resolvePageImageExportOutputDir,
  openExportOutputDirectory,
  removeFailedOutput,
} from "./pageImageExportOutput";
import { resolvePageImageExportWriteOptions } from "./pageImageExportOptions";
import { writePagePsdExport } from "./pagePsdExportRunner";

type EmitJobEvent = EmitPageImageExportEvent;

export const MAX_PAGE_IMAGE_EXPORT_CONCURRENCY = 4;

async function assertNoCancelCollisions({
  dependencies,
  outputDir,
  outputFormat,
  policy,
  preserveSourceNames,
  resolved,
}: {
  dependencies: PageImageExportDependencies;
  outputDir: string;
  outputFormat: PageImageExportFormat | "psd";
  policy: "replace" | "skip" | "cancel";
  preserveSourceNames: boolean;
  resolved: ResolvedPageImageExport;
}): Promise<void> {
  if (policy !== "cancel" || !dependencies.runtime.fileExists) return;
  for (const entry of resolved.chapters) {
    const chapterDir = resolveManualChapterOutputDir(
      outputDir,
      entry,
      preserveSourceNames,
    );
    for (const { page, pageIndex } of entry.pages) {
      const outputPath = resolveManualPageOutputPath({
        outputDir: chapterDir,
        outputFormat,
        page,
        pageIndex,
        preserveSourceNames,
      });
      if (await dependencies.runtime.fileExists(outputPath)) {
        throw new Error("같은 이름의 결과 파일이 있어 출력을 취소했습니다.");
      }
    }
  }
}

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
  request: PageExportSelectionRequest;
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
  const writeOptions = resolvePageImageExportWriteOptions(request);
  throwIfAborted(abortController, 0, resolved.pageCount);
  emitExportStarting(id, emit, resolved.pageCount, resolved.chapters.length);

  throwIfAborted(abortController, 0, resolved.pageCount);
  const output = await resolvePageImageExportOutputDir(
    outputParentDir,
    resolved.workTitle,
    writeOptions.destinationMode,
    dependencies,
  );
  const { outputDir } = output;
  try {
    throwIfAborted(abortController, 0, resolved.pageCount);
    await assertNoCancelCollisions({
      dependencies,
      outputDir,
      outputFormat: writeOptions.outputFormat,
      policy: writeOptions.collisionPolicy,
      preserveSourceNames: writeOptions.preserveSourceNames,
      resolved,
    });
    throwIfAborted(abortController, 0, resolved.pageCount);
    await writePageImageExportChapters({
      abortController,
      context,
      dependencies,
      emit,
      id,
      outputDir,
      resolved,
      ...writeOptions,
    });
    throwIfAborted(abortController, resolved.pageCount, resolved.pageCount);
  } catch (error) {
    if (output.removeOnFailure) {
      await removeFailedOutput(outputDir, error, dependencies);
    }
    throw error;
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
  request: PageExportSelectionRequest;
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

type PageImageExportWriteSettings = {
  omitText: boolean;
  outputFormat: PageImageExportFormat | "psd";
  jpegQuality: number;
  webpQuality: number;
  preserveSourceNames: boolean;
  collisionPolicy: "replace" | "skip" | "cancel";
};

type PageImageExportTask = {
  chapter: ChapterSnapshot;
  outputDir: string;
  page: MangaPage;
  pageIndex: number;
};

async function writePageImageExportChapters({
  abortController,
  context,
  dependencies,
  emit,
  id,
  outputDir,
  resolved,
  omitText,
  outputFormat,
  jpegQuality,
  webpQuality,
  preserveSourceNames,
  collisionPolicy,
}: {
  abortController: AbortController;
  context: InpaintingJobContext;
  dependencies: PageImageExportDependencies;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  resolved: ResolvedPageImageExport;
} & PageImageExportWriteSettings): Promise<void> {
  const tasks = await preparePageImageExportTasks({
    abortController,
    dependencies,
    outputDir,
    preserveSourceNames,
    resolved,
  });
  const sessions = await createPageImageExportSessions({
    context,
    dependencies,
    sessionCount: Math.min(MAX_PAGE_IMAGE_EXPORT_CONCURRENCY, tasks.length),
  });
  let operationFailure: { error: unknown } | null = null;
  try {
    await runPageImageExportTasks({
      abortController,
      dependencies,
      emit,
      id,
      sessions,
      tasks,
      totalPages: resolved.pageCount,
      writeSettings: {
        collisionPolicy,
        jpegQuality,
        omitText,
        outputFormat,
        preserveSourceNames,
        webpQuality,
      },
    });
  } catch (error) {
    operationFailure = { error };
  }
  const cleanupErrors = closePageImageExportSessions(sessions);
  throwPageImageExportPoolErrors(operationFailure, cleanupErrors);
}

async function preparePageImageExportTasks({
  abortController,
  dependencies,
  outputDir,
  preserveSourceNames,
  resolved,
}: {
  abortController: AbortController;
  dependencies: PageImageExportDependencies;
  outputDir: string;
  preserveSourceNames: boolean;
  resolved: ResolvedPageImageExport;
}): Promise<PageImageExportTask[]> {
  const tasks: PageImageExportTask[] = [];
  for (const entry of resolved.chapters) {
    throwIfAborted(abortController, 0, resolved.pageCount);
    const chapterDir = resolveManualChapterOutputDir(
      outputDir,
      entry,
      preserveSourceNames,
    );
    await dependencies.runtime.createDirectory(chapterDir, true);
    throwIfAborted(abortController, 0, resolved.pageCount);
    for (const pageEntry of entry.pages) {
      tasks.push({
        chapter: entry.chapter,
        outputDir: chapterDir,
        page: pageEntry.page,
        pageIndex: pageEntry.pageIndex,
      });
    }
  }
  return tasks;
}

function resolveManualChapterOutputDir(
  outputDir: string,
  entry: ResolvedPageImageExport["chapters"][number],
  preserveSourceNames: boolean,
): string {
  const hasSourceRelativePaths = entry.pages.every(({ page }) =>
    Boolean(page.sourceRelativePath),
  );
  if (preserveSourceNames && hasSourceRelativePaths) return outputDir;
  return join(
    outputDir,
    `${formatPageImageExportOrder(entry.chapterIndex)}-${sanitizeOutputPathSegment(entry.chapter.title, "chapter")}`,
  );
}

async function createPageImageExportSessions({
  context,
  dependencies,
  sessionCount,
}: {
  context: InpaintingJobContext;
  dependencies: PageImageExportDependencies;
  sessionCount: number;
}): Promise<PageExportRenderSession[]> {
  const results = await Promise.allSettled(
    Array.from({ length: sessionCount }, () =>
      dependencies.renderer.createSession({
        dataRoot: context.appPaths.dataRoot,
        decodeFallback: context.decodeImage,
      }),
    ),
  );
  const sessions = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const creationErrors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (creationErrors.length === 0) return sessions;

  const errors = [...creationErrors, ...closePageImageExportSessions(sessions)];
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(
    errors,
    "페이지 출력 렌더러 세션 준비와 정리에 실패했습니다.",
  );
}

async function runPageImageExportTasks({
  abortController,
  dependencies,
  emit,
  id,
  sessions,
  tasks,
  totalPages,
  writeSettings,
}: {
  abortController: AbortController;
  dependencies: PageImageExportDependencies;
  emit: EmitJobEvent;
  id: string;
  sessions: PageExportRenderSession[];
  tasks: PageImageExportTask[];
  totalPages: number;
  writeSettings: PageImageExportWriteSettings;
}): Promise<void> {
  let completedPages = 0;
  let nextTaskIndex = 0;
  const failures: unknown[] = [];

  async function worker(renderSession: PageExportRenderSession): Promise<void> {
    while (true) {
      if (abortController.signal.aborted || failures.length > 0) return;
      const task = tasks[nextTaskIndex];
      if (!task) return;
      nextTaskIndex += 1;
      try {
        emitExportPageProgress({
          id,
          emit,
          page: task.page,
          chapter: task.chapter,
          completedPages,
          totalPages,
          step: "running",
        });
        await writePageImageExportPage({
          abortController,
          dependencies,
          getCompletedPages: () => completedPages,
          outputDir: task.outputDir,
          page: task.page,
          pageIndex: task.pageIndex,
          renderSession,
          totalPages,
          ...writeSettings,
        });
        completedPages += 1;
        emitExportPageProgress({
          id,
          emit,
          page: task.page,
          chapter: task.chapter,
          completedPages,
          totalPages,
          step: "done",
        });
      } catch (error) {
        if (failures.length === 0) failures.push(error);
        return;
      }
    }
  }

  await Promise.all(sessions.map(worker));
  if (abortController.signal.aborted) {
    throw new PageImageExportAbortError(completedPages, totalPages);
  }
  if (failures.length > 0) throw failures[0];
}

function closePageImageExportSessions(
  sessions: PageExportRenderSession[],
): unknown[] {
  const errors: unknown[] = [];
  for (const session of sessions) {
    try {
      session.close();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwPageImageExportPoolErrors(
  operationFailure: { error: unknown } | null,
  cleanupErrors: unknown[],
): void {
  if (operationFailure && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationFailure.error, ...cleanupErrors],
      "페이지 출력과 렌더러 세션 정리에 함께 실패했습니다.",
      { cause: operationFailure.error },
    );
  }
  if (operationFailure) throw operationFailure.error;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      "페이지 출력 렌더러 세션 정리에 실패했습니다.",
    );
  }
}

async function writePageImageExportPage({
  abortController,
  dependencies,
  getCompletedPages,
  outputDir,
  page,
  pageIndex,
  renderSession,
  totalPages,
  omitText,
  outputFormat,
  jpegQuality,
  webpQuality,
  preserveSourceNames,
  collisionPolicy,
}: {
  abortController: AbortController;
  dependencies: PageImageExportDependencies;
  getCompletedPages: () => number;
  outputDir: string;
  page: MangaPage;
  pageIndex: number;
  renderSession: PageExportRenderSession;
  totalPages: number;
  omitText: boolean;
  outputFormat: PageImageExportFormat | "psd";
  jpegQuality: number;
  webpQuality: number;
  preserveSourceNames: boolean;
  collisionPolicy: "replace" | "skip" | "cancel";
}): Promise<void> {
  throwIfAborted(abortController, getCompletedPages(), totalPages);
  const outputPath = resolveManualPageOutputPath({
    outputDir,
    outputFormat,
    page,
    pageIndex,
    preserveSourceNames,
  });
  if (await shouldSkipOutput(outputPath, collisionPolicy, dependencies)) return;
  await dependencies.runtime.createDirectory(dirname(outputPath), true);
  throwIfAborted(abortController, getCompletedPages(), totalPages);
  if (outputFormat === "psd") {
    await writePagePsdExport({
      abortController,
      completedPages: getCompletedPages(),
      dependencies,
      omitText,
      outputPath,
      page,
      renderSession,
      throwIfAborted,
      totalPages,
    });
    return;
  }
  const capture = resolveManualCaptureOptions(
    outputFormat,
    page,
    jpegQuality,
    webpQuality,
  );
  const content = await renderSession.renderPage(
    omitText ? { ...page, blocks: [] } : page,
    capture,
  );
  throwIfAborted(abortController, getCompletedPages(), totalPages);
  assertManualPageExportResult(content, capture.format, page.name);
  await (dependencies.runtime.writeImage ?? dependencies.runtime.writePng)(
    outputPath,
    content,
  );
}

function assertManualPageExportResult(
  content: Buffer,
  format: "png" | "jpeg" | "webp",
  pageName: string,
): void {
  if (format !== "png") return;
  assertPageExportPngBuffer(
    content,
    undefined,
    pageName,
    MAX_PAGE_EXPORT_ORIGINAL_IMAGE_BYTES,
    ORIGINAL_PAGE_EXPORT_RASTER_LIMITS,
  );
}

function resolveManualPageOutputPath({
  outputDir,
  outputFormat,
  page,
  pageIndex,
  preserveSourceNames,
}: {
  outputDir: string;
  outputFormat: PageImageExportFormat | "psd";
  page: MangaPage;
  pageIndex: number;
  preserveSourceNames: boolean;
}): string {
  const sourceName = page.sourceFileName ?? page.name;
  const sourceExtension = extname(sourceName).toLowerCase();
  const extension =
    outputFormat === "source"
      ? [".png", ".jpg", ".jpeg", ".webp"].includes(sourceExtension)
        ? sourceExtension
        : ".png"
      : outputFormat === "jpeg"
        ? ".jpg"
        : `.${outputFormat}`;
  if (!preserveSourceNames) {
    return join(
      outputDir,
      `${formatPageImageExportOrder(pageIndex)}-${sanitizeOutputBaseName(page.name)}${extension}`,
    );
  }
  const relativeSource = (page.sourceRelativePath ?? sourceName).replaceAll(
    "\\",
    "/",
  );
  const segments = relativeSource
    .split("/")
    .filter(Boolean)
    .map((segment, index, all) =>
      index === all.length - 1
        ? sanitizeOutputBaseName(segment)
        : sanitizeOutputPathSegment(segment, "folder"),
    );
  return join(
    outputDir,
    ...segments.slice(0, -1),
    `${segments.at(-1) ?? "page"}${extension}`,
  );
}

function resolveManualCaptureOptions(
  outputFormat: PageImageExportFormat,
  page: MangaPage,
  jpegQuality: number,
  webpQuality: number,
) {
  const sourceExtension = extname(
    page.sourceFileName ?? page.name,
  ).toLowerCase();
  const format =
    outputFormat === "source"
      ? sourceExtension === ".jpg" || sourceExtension === ".jpeg"
        ? "jpeg"
        : sourceExtension === ".webp"
          ? "webp"
          : "png"
      : outputFormat;
  return {
    format,
    resolutionMode: "original",
    ...(format === "jpeg"
      ? { quality: jpegQuality }
      : format === "webp"
        ? { quality: webpQuality }
        : {}),
  } as const;
}

async function shouldSkipOutput(
  outputPath: string,
  policy: "replace" | "skip" | "cancel",
  dependencies: PageImageExportDependencies,
): Promise<boolean> {
  const exists = dependencies.runtime.fileExists
    ? await dependencies.runtime.fileExists(outputPath)
    : false;
  if (!exists) return false;
  if (policy === "skip") return true;
  if (policy === "cancel") {
    throw new Error("같은 이름의 결과 파일이 있어 출력을 취소했습니다.");
  }
  return false;
}

function assertTextlessExportReady(
  request: PageExportSelectionRequest,
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
