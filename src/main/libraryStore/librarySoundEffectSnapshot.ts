import type { MangaPage } from "../../shared/libraryTypes";
import type { SoundEffectPageSnapshot } from "../../shared/soundEffectPageSnapshot";
import {
  captureSoundEffectPage,
  restoreSoundEffectPage,
} from "../../shared/soundEffectPageSnapshot";
import { createPageRevision } from "../../shared/pageRevision";
import { hashStableValue } from "../../shared/blockFingerprint";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "./libraryFiles";
import { nextChapterUpdatedAt, resolveChapterStatus } from "./chapterRecords";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import { hydrateChapter } from "./chapterSnapshots";

/** Trusted calculated SFX snapshots only. The locked facade owns the activity check. */
export async function commitSoundEffectSnapshotUnlocked(
  target: { chapterId: string; pageId: string; revision: string },
  expected: SoundEffectPageSnapshot,
  replacement: SoundEffectPageSnapshot,
  guard: () => void,
  committed: (page: MangaPage) => void,
) {
  guard();
  const location = await findChapterLocation(target.chapterId);
  if (!location) throw new Error("Sound-effect chapter is unavailable.");
  const chapter = await readChapterFile(location.workId, location.chapterId);
  const page = chapter?.pages.find((page) => page.id === target.pageId);
  if (!chapter || !page) throw new Error("Sound-effect page is unavailable.");
  if (
    createPageRevision(page) !== target.revision ||
    hashStableValue(captureSoundEffectPage(page)) !== hashStableValue(expected)
  )
    throw new Error("Sound-effect page changed before the native transaction.");
  const work = await readWorkFile(chapter.workId);
  if (!work) throw new Error("Sound-effect work is unavailable.");
  const now = nextChapterUpdatedAt(chapter);
  const pages = chapter.pages.map((item) =>
    item.id === target.pageId
      ? { ...restoreSoundEffectPage(item, replacement), updatedAt: now }
      : item,
  );
  const next = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  await runLibraryTransaction(
    "prepare-sound-effect-translation",
    async (transaction) => {
      guard();
      await stageChapterFile(transaction, next);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
    },
    undefined,
    guard,
  );
  const hydrated = hydrateChapter(next);
  const updated = hydrated.pages.find((page) => page.id === target.pageId);
  if (!updated) throw new Error("Committed sound-effect page is missing.");
  committed(updated);
  return hydrated;
}
