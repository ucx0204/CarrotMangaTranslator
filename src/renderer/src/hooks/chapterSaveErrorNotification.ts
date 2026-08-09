import type {
  ChapterPersistenceRefs,
  UseChapterPersistenceOptions,
} from "./chapterPersistenceTypes";

const SAVE_ERROR_DEDUPE_MS = 5000;

export function notifySaveErrorDeduped(
  lastSaveErrorRef: ChapterPersistenceRefs["lastSaveErrorRef"],
  onSaveError: UseChapterPersistenceOptions["onSaveError"],
  message: string,
): void {
  const now = Date.now();
  const last = lastSaveErrorRef.current;
  if (
    last &&
    last.message === message &&
    now - last.shownAt < SAVE_ERROR_DEDUPE_MS
  ) {
    return;
  }
  lastSaveErrorRef.current = { message, shownAt: now };
  onSaveError?.(message);
}
