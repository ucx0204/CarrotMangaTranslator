/* eslint-disable max-lines-per-function -- whole-work share staging and publication stay in one auditable transaction assembly */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkStyleGuideSchema } from "../../shared/ipcSchemas";
import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareImportFromPackageRequest,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import { tMain } from "./localization";
import { hydrateChapter } from "./chapterSnapshots";
import {
  createUnpublishedWork,
  readIndexFile,
  validateWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageIndexFile } from "./libraryTransactionFiles";
import { importWorkShareIntoExistingWork } from "./shareImportExistingWorkflow";
import { materializeSharedChapter } from "./shareImportMaterialize";
import {
  assertPackageOnlyEntries,
  openSharePackageSession,
  type SharePackageReaderRuntime,
  type SharePackageSession,
} from "./sharePackage";
import { writeJsonFile } from "./storage";
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
  throwIfAborted(signal);
  const requestedWorkTitle = request.target.title;
  const packageEntries = request.entries.map((entry) => {
    if (entry.source !== "package") {
      throw new Error(tMain("share.errors.notNewWorkRequest"));
    }
    return entry;
  });

  return runLibraryTransaction("share-import-new-work", async (transaction) => {
    const work = createUnpublishedWork(
      requestedWorkTitle || session.manifest.work.title,
    );
    const index = await readIndexFile();
    const finalWorkDirectory = join(getWorksRoot(), work.id);
    const published =
      await transaction.createPublishedDirectory(finalWorkDirectory);
    const usedTitles = new Set<string>();
    const createdChapters: ChapterFile[] = [];

    for (const entry of packageEntries) {
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
      usedTitles.add(title);
      const chapterId = randomUUID();
      const writeChapterDirectory = join(
        published.stagingDirectory,
        "chapters",
        chapterId,
      );
      const publishedChapterDirectory = join(
        published.finalDirectory,
        "chapters",
        chapterId,
      );
      await mkdir(writeChapterDirectory, { recursive: true });
      const chapter = await materializeSharedChapter({
        workId: work.id,
        chapterId,
        packageChapter,
        entries: session.entries,
        archiveReader: session.archiveReader,
        requestedTitle: title,
        signal,
        writeChapterDirectory,
        publishedChapterDirectory,
      });
      createdChapters.push(chapter);
    }

    if (createdChapters.length === 0) {
      throw new Error(tMain("share.errors.noChapters"));
    }
    const chapterIds = createdChapters.map((chapter) => chapter.id);
    const nextWork: WorkFile = {
      ...work,
      chapterOrder: chapterIds,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(
      join(published.stagingDirectory, "work.json"),
      validateWorkFile(nextWork.id, nextWork),
    );

    if (session.styleGuide) {
      throwIfAborted(signal);
      const styleGuide = WorkStyleGuideSchema.parse({
        ...session.styleGuide,
        workId: work.id,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonFile(
        join(published.stagingDirectory, "style-guide.json"),
        styleGuide,
      );
    }
    await stageIndexFile(transaction, {
      workOrder: [...index.workOrder, work.id],
    });
    throwIfAborted(signal);

    const openedChapter = createdChapters[0];
    if (!openedChapter) {
      throw new Error(tMain("share.errors.importedChapterOpen"));
    }
    return {
      workId: work.id,
      chapterIds,
      openedChapter: hydrateChapter(openedChapter),
    };
  });
}
