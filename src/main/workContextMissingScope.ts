import type {
  AnalyzeWorkContextResult,
  ChapterSnapshot,
  WorkStyleGuide,
} from "../shared/types";
import { getChapterStoryMemory } from "./library";
import { tMain } from "./i18n";

/**
 * Translated chapters whose story memory has never been stamped by AI analysis.
 * Untranslated chapters are skipped so a per-chapter run doesn't prematurely
 * mark future chapters as analyzed.
 */
export async function filterUnanalyzedChapters(
  chapters: ChapterSnapshot[],
): Promise<ChapterSnapshot[]> {
  const unanalyzed: ChapterSnapshot[] = [];
  for (const chapter of chapters) {
    const hasTranslatedPage = chapter.pages.some(
      (page) => page.analysisStatus === "completed",
    );
    if (!hasTranslatedPage) {
      continue;
    }
    const memory = await getChapterStoryMemory(chapter.id);
    if (!memory.aiAnalyzedAt) {
      unanalyzed.push(chapter);
    }
  }
  return unanalyzed;
}

/** No-op analysis result returned when every chapter is already analyzed. */
export async function buildAlreadyAnalyzedResult({
  guide,
  chapterId,
  workId,
  totalChapters,
  maxInputChars,
}: {
  guide: WorkStyleGuide;
  chapterId: string;
  workId: string;
  totalChapters: number;
  maxInputChars: number;
}): Promise<AnalyzeWorkContextResult> {
  return {
    styleGuide: guide,
    storyMemory: await getChapterStoryMemory(chapterId),
    coverage: {
      scope: "work",
      workId,
      requestedChapterId: chapterId,
      totalChapters,
      includedChapters: 0,
      totalPages: 0,
      includedPages: 0,
      selectedChars: 0,
      maxInputChars,
      truncated: false,
    },
    counts: {
      glossaryAdded: 0,
      glossaryUpdated: 0,
      charactersAdded: 0,
      charactersUpdated: 0,
      rulesUpdated: 0,
      pageSummariesUpserted: 0,
    },
    warnings: [tMain("workContext.warnings.alreadyAnalyzed")],
  };
}
