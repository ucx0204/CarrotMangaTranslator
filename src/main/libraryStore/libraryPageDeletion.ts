import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPathInside } from "./storage";
import type { ChapterStoryMemory } from "../../shared/workContextTypes";
import { hashStableValue } from "../../shared/blockFingerprint";
import { nextChapterUpdatedAt, resolveChapterStatus } from "./chapterRecords";
import {
  readChapterFile,
  readWorkFile,
  type ChapterFile,
  type WorkFile,
} from "./libraryFiles";
import { getChapterFilePath } from "./libraryPaths";
import { readLibraryPageOrdering } from "./libraryPageOrdering";
import { resolveReconciledStoryMemory } from "./workContextFiles";
import { resolveManagedCheckpointDirectory } from "./translationCheckpointStore";
import { isUnreferencedPageMask } from "./inpaintedArtifacts";
import {
  stageChapterFile,
  stageStoryMemoryFile,
  stageWorkFile,
} from "./libraryTransactionFiles";
import type { LibraryTransaction } from "./libraryTransaction";

export type PageDeletionFrame = {
  work: WorkFile;
  chapter: ChapterFile;
  memory: ChapterStoryMemory | null;
};

/** Same native metadata/status/memory policy for desktop removal and reviewed MCP publication. */
export function preparePageDeletionFrame(
  before: PageDeletionFrame,
  pageId: string,
  updatedAt: string,
) {
  const pages = before.chapter.pages.filter((page) => page.id !== pageId);
  if (pages.length === before.chapter.pages.length)
    throw new Error("삭제할 페이지가 없습니다.");
  return {
    work: { ...before.work, updatedAt },
    chapter: {
      ...before.chapter,
      pages,
      pageOrder: before.chapter.pageOrder.filter((id) => id !== pageId),
      updatedAt,
      status: resolveChapterStatus(pages),
    },
    memory: before.memory
      ? resolveReconciledStoryMemory(before.memory, pages, updatedAt)
      : null,
  };
}

/** Native paths derived solely from validated chapter metadata and actual run directory names. */
export function pageDeletionPaths(
  chapter: ChapterFile,
  pageId: string,
  runNames: string[],
) {
  const target = chapter.pages.find((page) => page.id === pageId);
  if (!target) throw new Error("삭제할 페이지가 없습니다.");
  const directory = dirname(getChapterFilePath(chapter.workId, chapter.id));
  const remaining = chapter.pages.filter((page) => page.id !== pageId);
  const preserved = remaining
    .flatMap((page) => [
      page.imagePath,
      page.inpaintedImagePath,
      page.inpaintMaskPath,
      ...(page.translationCheckpoint
        ? [
            resolveManagedCheckpointDirectory(
              directory,
              page.translationCheckpoint,
            ),
          ]
        : []),
    ])
    .filter((path): path is string => Boolean(path));
  const directories = runNames.map((run) =>
    join(directory, "runs", run, "pages", pageId),
  );
  if (target.translationCheckpoint)
    directories.push(
      resolveManagedCheckpointDirectory(
        directory,
        target.translationCheckpoint,
      ),
    );
  const eligible = [...new Set(directories)].filter(
    (path) =>
      !preserved.some(
        (kept) => isPathInside(path, kept) || isPathInside(kept, path),
      ),
  );
  const roots = eligible.filter(
    (path) =>
      !eligible.some((parent) => parent !== path && isPathInside(parent, path)),
  );
  const mask = target.inpaintMaskPath;
  const candidates = [
    target.imagePath,
    target.inpaintedImagePath,
    ...(mask && isUnreferencedPageMask(directory, mask, remaining)
      ? [mask]
      : []),
  ];
  const files = [
    ...new Set(candidates.filter((path): path is string => Boolean(path))),
  ].filter(
    (path) =>
      !preserved.some(
        (kept) => isPathInside(kept, path) || isPathInside(path, kept),
      ) && !roots.some((parent) => isPathInside(parent, path)),
  );
  return { files, directories: roots };
}

/** Caller owns the existing library boundary. Missing-page desktop behavior remains a no-op. */
export async function preparePageDeletionUnlocked(
  workId: string,
  chapterId: string,
  pageId: string,
) {
  const work = await readWorkFile(workId);
  const chapter = await readChapterFile(workId, chapterId);
  if (!work || !chapter || !work.chapterOrder.includes(chapterId))
    throw new Error("화를 찾지 못했습니다.");
  if (!chapter.pages.some((page) => page.id === pageId))
    return { chapter, change: null };
  const { memory } = await readLibraryPageOrdering(chapter);
  const before = { work, chapter, memory };
  const after = preparePageDeletionFrame(
    before,
    pageId,
    nextChapterUpdatedAt(chapter),
  );
  const runs = await readRunNames(
    dirname(getChapterFilePath(workId, chapterId)),
  );
  return {
    chapter,
    change: { before, after, ...pageDeletionPaths(chapter, pageId, runs) },
  };
}

/** The caller may stage verified recovery in this same transaction. No second delete implementation. */
export async function stagePageDeletionUnlocked(
  transaction: LibraryTransaction,
  change: {
    before: PageDeletionFrame;
    after: PageDeletionFrame;
    files: string[];
    directories: string[];
  },
) {
  await stageChapterFile(transaction, change.after.chapter);
  if (
    change.after.memory &&
    hashStableValue(change.before.memory) !==
      hashStableValue(change.after.memory)
  )
    await stageStoryMemoryFile(transaction, change.after.memory);
  await stageWorkFile(transaction, change.after.work);
  for (const file of change.files)
    await transaction.retireFile(file, { required: false });
  for (const directory of change.directories)
    await transaction.retireDirectory(directory, { required: false });
}

async function readRunNames(directory: string): Promise<string[]> {
  const entries = await readdir(join(directory, "runs"), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
}
