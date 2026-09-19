import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  restorePageRecovery,
  type PageRecoverySnapshot,
} from "../../shared/pageRecoverySnapshot";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../../shared/pageRevision";
import { readChapterFile, readWorkFile } from "./libraryFiles";
import { getChapterFilePath } from "./libraryPaths";
import {
  runLibraryTransaction,
  type LibraryTransaction,
} from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import { nextChapterUpdatedAt, resolveChapterStatus } from "./chapterRecords";
import { hydrateChapter } from "./chapterSnapshots";
import {
  copyDurableBackup,
  assertPathWithinRootWithoutSymlinks,
} from "./libraryTransactionStorage";
import { getLibraryRoot } from "./libraryPaths";

export type PageRecoveryUpdate = {
  workId: string;
  chapterId: string;
  pageId: string;
  revision: string;
  reviewRevision: string;
  snapshot: PageRecoverySnapshot;
  copies: {
    field: "inpaintedImagePath" | "inpaintMaskPath";
    source: string;
    sha256: string;
  }[];
};
/** Trusted computed replacements only; transport input never contains snapshots or paths. */
export async function commitPageRecoveryUnlocked(
  updates: PageRecoveryUpdate[],
  guard: () => void,
  verify: () => Promise<void>,
  receipt: (
    transaction: LibraryTransaction,
    pages: { chapterId: string; page: MangaPage }[],
  ) => Promise<void>,
) {
  guard();
  await verify();
  const chapters = await readRecoveryChapters(updates);
  return runLibraryTransaction(
    "mcp-durable-page-recovery",
    async (transaction) => {
      for (const update of updates) {
        const chapter = chapters.get(update.chapterId);
        if (!chapter) throw new Error("Recovery chapter is unavailable.");
        const snapshot = await publishRecoveryImages(
          transaction,
          update,
          guard,
        );
        chapter.pages = chapter.pages.map((page) =>
          page.id === update.pageId
            ? restorePageRecovery(page, snapshot)
            : page,
        );
      }
      const saved = await stageRecoveryChapters(transaction, chapters, updates);
      await receipt(transaction, saved);
      transaction.beforePublish(verify);
      return saved;
    },
    undefined,
    guard,
  );
}
type RecoveryChapter = NonNullable<Awaited<ReturnType<typeof readChapterFile>>>;
async function readRecoveryChapters(updates: PageRecoveryUpdate[]) {
  const chapters = new Map<string, RecoveryChapter>();
  for (const update of updates) {
    let chapter = chapters.get(update.chapterId);
    if (!chapter) {
      chapter =
        (await readChapterFile(update.workId, update.chapterId)) ?? undefined;
      if (!chapter) throw new Error("Recovery chapter is missing.");
      chapters.set(chapter.id, chapter);
    }
    const page = chapter.pages.find((item) => item.id === update.pageId);
    if (
      !page ||
      chapter.workId !== update.workId ||
      createPageRevision(page) !== update.revision ||
      createSoundEffectReviewPageRevision(page) !== update.reviewRevision
    )
      throw new Error("Recovery page changed before the native transaction.");
    assertRecoverySource(page, update.snapshot);
  }
  return chapters;
}
async function stageRecoveryChapters(
  transaction: LibraryTransaction,
  chapters: Map<string, RecoveryChapter>,
  updates: PageRecoveryUpdate[],
) {
  const workIds = new Set<string>();
  const saved: { chapterId: string; page: MangaPage }[] = [];
  for (const chapter of chapters.values()) {
    const now = nextChapterUpdatedAt(chapter);
    chapter.updatedAt = now;
    chapter.pages = chapter.pages.map((page) =>
      updates.some(
        (item) => item.chapterId === chapter.id && item.pageId === page.id,
      )
        ? { ...page, updatedAt: now }
        : page,
    );
    chapter.status = resolveChapterStatus(chapter.pages);
    await stageChapterFile(transaction, chapter);
    for (const page of hydrateChapter(chapter).pages)
      if (
        updates.some(
          (item) => item.chapterId === chapter.id && item.pageId === page.id,
        )
      )
        saved.push({ chapterId: chapter.id, page });
    if (!workIds.has(chapter.workId)) {
      const work = await readWorkFile(chapter.workId);
      if (!work) throw new Error("Recovery work is missing.");
      await stageWorkFile(transaction, { ...work, updatedAt: now });
      workIds.add(work.id);
    }
  }
  return saved;
}
async function publishRecoveryImages(
  transaction: LibraryTransaction,
  update: PageRecoveryUpdate,
  guard: () => void,
) {
  const snapshot = structuredClone(update.snapshot);
  if (!update.copies.length) return snapshot;
  const final = join(
    dirname(getChapterFilePath(update.workId, update.chapterId)),
    `.mcp-recovered-${randomUUID()}`,
  );
  const directory = await transaction.createPublishedDirectory(final);
  for (const copy of update.copies) {
    guard();
    await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), copy.source);
    const name = `${copy.field}.png`;
    if (
      (await copyDurableBackup(
        copy.source,
        join(directory.stagingDirectory, name),
      )) !== copy.sha256
    )
      throw new Error("Retained recovery image content changed.");
    snapshot[copy.field] = join(directory.finalDirectory, name);
  }
  guard();
  return snapshot;
}

function assertRecoverySource(
  page: PageRecoverySnapshot,
  snapshot: PageRecoverySnapshot,
) {
  if (
    page.id !== snapshot.id ||
    page.imagePath !== snapshot.imagePath ||
    page.width !== snapshot.width ||
    page.height !== snapshot.height
  )
    throw new Error("Recovery cannot replace an original page.");
}
