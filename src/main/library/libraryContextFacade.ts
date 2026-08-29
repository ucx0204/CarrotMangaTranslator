import type {
  ChapterStoryMemory,
  ResetWorkContextResult,
  SaveWorkResearchTitleRequest,
  WorkStyleGuide,
  WorkResearchTitlePreference,
} from "../../shared/workContextTypes";
import type {
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "../../shared/reviewTypes";
import { applyReviewImportUnlocked } from "../libraryStore/reviewImport";
import {
  readChapterStoryMemory,
  readWorkResearchTitlePreference,
  readWorkStyleGuide,
  resetWorkContextForChapter,
  resolveWorkContextForChapter as resolveWorkContextForChapterUnlocked,
  writeChapterStoryMemory,
  writeWorkResearchTitlePreference,
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
  workTitle: string;
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

export async function resetWorkContext(
  chapterId: string,
): Promise<ResetWorkContextResult> {
  return withLibraryMutation(() => resetWorkContextForChapter(chapterId));
}

export async function getWorkResearchTitle(
  workId: string,
): Promise<WorkResearchTitlePreference | null> {
  return withLibraryRead(() => readWorkResearchTitlePreference(workId));
}

export async function saveWorkResearchTitle(
  request: SaveWorkResearchTitleRequest,
): Promise<WorkResearchTitlePreference> {
  return withLibraryMutation(() => writeWorkResearchTitlePreference(request));
}

export async function importReviewText(
  request: ImportReviewTextRequest,
): Promise<ImportReviewTextResult> {
  return withLibraryMutation(() => applyReviewImportUnlocked(request));
}
