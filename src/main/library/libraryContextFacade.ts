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
import {
  assertLibraryActivityAccess,
  withLibraryMutation,
  withLibraryRead,
} from "./lock";
import { pageContentResource } from "../../shared/appActivityTypes";

export async function getWorkStyleGuide(
  workId: string,
): Promise<WorkStyleGuide> {
  return withLibraryRead(() => readWorkStyleGuide(workId));
}

export async function saveWorkStyleGuide(
  guide: WorkStyleGuide,
  expectedUpdatedAt?: string,
): Promise<WorkStyleGuide> {
  return withLibraryMutation(() => {
    assertLibraryActivityAccess([
      { kind: "work-context", scope: guide.workId, access: "write" },
    ]);
    return writeWorkStyleGuide(guide, expectedUpdatedAt);
  });
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
  expectedUpdatedAt?: string,
): Promise<ChapterStoryMemory> {
  return withLibraryMutation(() => {
    assertLibraryActivityAccess([
      { kind: "work-context", scope: memory.workId, access: "write" },
    ]);
    return writeChapterStoryMemory(memory, expectedUpdatedAt);
  });
}

export async function resetWorkContext(
  chapterId: string,
): Promise<ResetWorkContextResult> {
  return withLibraryMutation(async () => {
    const context = await resolveWorkContextForChapterUnlocked(chapterId);
    assertLibraryActivityAccess([
      { kind: "work-context", scope: context.workId, access: "write" },
    ]);
    return resetWorkContextForChapter(chapterId);
  });
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
  return withLibraryMutation(() => {
    assertLibraryActivityAccess([pageContentResource(request.chapterId, "**")]);
    return applyReviewImportUnlocked(request);
  });
}
