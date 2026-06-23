import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import type {
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "../../shared/reviewTypes";
import { applyReviewImportUnlocked } from "../libraryStore/reviewImport";
import {
  readChapterStoryMemory,
  readWorkStyleGuide,
  resolveWorkContextForChapter as resolveWorkContextForChapterUnlocked,
  writeChapterStoryMemory,
  writeWorkStyleGuide,
} from "../libraryStore/workContextFiles";
import { withLibraryMutation, withLibraryRead } from "./lock";

export async function getWorkStyleGuide(
  workId: string,
): Promise<WorkStyleGuide> {
  return withLibraryRead(() => readWorkStyleGuide(workId));
}

export async function saveWorkStyleGuide(
  guide: WorkStyleGuide,
): Promise<WorkStyleGuide> {
  return withLibraryMutation(() => writeWorkStyleGuide(guide));
}

export async function getChapterStoryMemory(
  chapterId: string,
): Promise<ChapterStoryMemory> {
  return withLibraryRead(() => readChapterStoryMemory(chapterId));
}

export async function resolveWorkContextForChapter(chapterId: string): Promise<{
  workId: string;
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
}> {
  return withLibraryRead(() => resolveWorkContextForChapterUnlocked(chapterId));
}

export async function saveChapterStoryMemory(
  memory: ChapterStoryMemory,
): Promise<ChapterStoryMemory> {
  return withLibraryMutation(() => writeChapterStoryMemory(memory));
}

export async function importReviewText(
  request: ImportReviewTextRequest,
): Promise<ImportReviewTextResult> {
  return withLibraryMutation(() => applyReviewImportUnlocked(request));
}
