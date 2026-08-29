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
  let renderSession: PageExportRenderSession | null = null;
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
      ...writeOptions,
    });
    throwIfAborted(abortController, resolved.pageCount, resolved.pageCount);
  } catch (error) {
    if (output.removeOnFailure) {
      await removeFailedOutput(outputDir, error, dependencies);
    }
    throw error;
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
  jpegQuality,
  webpQuality,
  preserveSourceNames,
  collisionPolicy,
}: {
  abortController: AbortController;
  dependencies: PageImageExportDependencies;
  emit: EmitJobEvent;
  id: string;
  outputDir: string;
  renderSession: PageExportRenderSession;
  resolved: ResolvedPageImageExport;
  omitText: boolean;
  outputFormat: PageImageExportFormat | "psd";
  jpegQuality: number;
  webpQuality: number;
  preserveSourceNames: boolean;
  collisionPolicy: "replace" | "skip" | "cancel";
}): Promise<void> {
  let completedPages = 0;
  for (const entry of resolved.chapters) {
    const chapterDir = resolveManualChapterOutputDir(
      outputDir,
      entry,
      preserveSourceNames,
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
      jpegQuality,
      webpQuality,
      preserveSourceNames,
      collisionPolicy,
    });
  }
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
  jpegQuality,
  webpQuality,
  preserveSourceNames,
  collisionPolicy,
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
  outputFormat: PageImageExportFormat | "psd";
  jpegQuality: number;
  webpQuality: number;
  preserveSourceNames: boolean;
  collisionPolicy: "replace" | "skip" | "cancel";
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
      jpegQuality,
      webpQuality,
      preserveSourceNames,
      collisionPolicy,
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
  jpegQuality,
  webpQuality,
  preserveSourceNames,
  collisionPolicy,
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
  outputFormat: PageImageExportFormat | "psd";
  jpegQuality: number;
  webpQuality: number;
  preserveSourceNames: boolean;
  collisionPolicy: "replace" | "skip" | "cancel";
}): Promise<void> {
  const outputPath = resolveManualPageOutputPath({
    outputDir,
    outputFormat,
    page,
    pageIndex,
    preserveSourceNames,
  });
  if (await shouldSkipOutput(outputPath, collisionPolicy, dependencies)) return;
  await dependencies.runtime.createDirectory(dirname(outputPath), true);
  if (outputFormat === "psd") {
    await writePagePsdExport({
      abortController,
      completedPages,
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
  throwIfAborted(abortController, completedPages, totalPages);
  assertManualPageExportResult(content, capture.format, page.name);
  await (dependencies.runtime.writeImage ?? dependencies.runtime.writePng)(
    outputPath,
    content,
  );
  throwIfAborted(abortController, completedPages + 1, totalPages);
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
