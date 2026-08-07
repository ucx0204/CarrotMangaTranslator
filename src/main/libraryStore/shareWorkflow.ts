import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareImportFromPackageRequest,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import { tMain } from "./localization";
import { hydrateChapter } from "./chapterSnapshots";
import {
  createWork,
  removeChapterDirectory,
  removeWorkFromIndexAndDisk,
  writeWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { importWorkShareIntoExistingWork } from "./shareImportExistingWorkflow";
import { materializeSharedChapter } from "./shareImportMaterialize";
import { writeWorkStyleGuide } from "./workContextFiles";
import {
  assertPackageOnlyEntries,
  openSharePackageSession,
  type SharePackageReaderRuntime,
  type SharePackageSession,
} from "./sharePackage";
import { makeUniqueTitleInList, sanitizeTitle } from "./titles";

export type ShareWorkflowRuntime = {
  openPackage: typeof openSharePackageSession;
};

const productionShareWorkflowRuntime: ShareWorkflowRuntime = {
  openPackage: openSharePackageSession,
};

export async function previewWorkShareImport(
  packagePath: string,
  options: {
    signal?: AbortSignal;
    readerRuntime?: SharePackageReaderRuntime;
  } = {},
): Promise<WorkShareImportPreviewView> {
  const session = await openSharePackageSession(packagePath, {
    signal: options.signal,
    runtime: options.readerRuntime,
  });
  try {
    const chapters: WorkShareImportPreviewView["chapters"] = [];
    for (const packageChapterId of session.manifest.chapterOrder) {
      throwIfAborted(options.signal);
      const chapter = await session.readChapter(
        packageChapterId,
        options.signal,
      );
      chapters.push({
        packageChapterId,
        title: chapter.title,
        pageCount: chapter.pages.length,
      });
    }
    return {
      workTitle: session.manifest.work.title,
      chapters,
    };
  } finally {
    session.close();
  }
}

export async function importWorkShareUnlocked(
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
  runtime: ShareWorkflowRuntime = productionShareWorkflowRuntime,
): Promise<WorkShareImportResult> {
  throwIfAborted(signal);
  const session = await runtime.openPackage(request.packagePath, { signal });

  try {
    throwIfAborted(signal);
    if (request.entries.length === 0) {
      throw new Error(tMain("share.errors.noChapters"));
    }

    if (request.target.mode === "new") {
      return await importWorkShareAsNewWork(session, request, signal);
    }

    return await importWorkShareIntoExistingWork(session, request, signal);
  } finally {
    session.close();
  }
}

async function importWorkShareAsNewWork(
  session: SharePackageSession,
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  if (request.target.mode !== "new") {
    throw new Error(tMain("share.errors.notNewWorkRequest"));
  }
  assertPackageOnlyEntries(request.entries);

  let work: WorkFile | null = null;
  const usedTitles = new Set<string>();
  const createdChapters: ChapterFile[] = [];

  try {
    throwIfAborted(signal);
    work = await createWork(
      request.target.title || session.manifest.work.title,
    );
    throwIfAborted(signal);

    for (const entry of request.entries) {
      throwIfAborted(signal);
      const packageChapter = await session.readChapter(
        entry.packageChapterId,
        signal,
      );
      const title = makeUniqueTitleInList(
        sanitizeTitle(
          entry.title || packageChapter.title,
          tMain("import.untitled"),
        ),
        usedTitles,
      );
      const chapter = await materializeSharedChapter({
        workId: work.id,
        packageChapter,
        entries: session.entries,
        archiveReader: session.archiveReader,
        requestedTitle: title,
        signal,
      });
      createdChapters.push(chapter);
      throwIfAborted(signal);
    }

    if (createdChapters.length === 0) {
      throw new Error(tMain("share.errors.noChapters"));
    }

    const chapterIds = createdChapters.map((chapter) => chapter.id);
    work.chapterOrder = chapterIds;
    work.updatedAt = new Date().toISOString();
    throwIfAborted(signal);
    await writeWorkFile(work);
    if (session.styleGuide) {
      throwIfAborted(signal);
      await writeWorkStyleGuide({
        ...session.styleGuide,
        workId: work.id,
      });
    }

    const openedChapter = createdChapters[0];
    if (!openedChapter) {
      throw new Error(tMain("share.errors.importedChapterOpen"));
    }

    return {
      workId: work.id,
      chapterIds,
      openedChapter: hydrateChapter(openedChapter),
    };
  } catch (error) {
    for (const chapter of createdChapters) {
      await removeChapterDirectory(chapter.workId, chapter.id);
    }
    if (work) {
      await removeWorkFromIndexAndDisk(work.id);
    }
    throw error;
  }
}
