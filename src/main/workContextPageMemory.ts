import type {
  ChapterStoryMemory,
  PageStoryMemory,
} from "../shared/workContextTypes";
import {
  cleanText,
  normalizeKey,
  sanitizeList,
} from "./workContextAiMergeUtils";
import type {
  AiPageSummarySuggestion,
  BasePageMemory,
} from "./workContextAiTypes";

export function buildMergedPageMemory(
  basePage: BasePageMemory,
  suggestion: AiPageSummarySuggestion,
  characterIndex: Map<string, string>,
  existingPage: PageStoryMemory | undefined,
  now: string,
): PageStoryMemory {
  const { workId: _workId, chapterId: _chapterId, ...pageMemory } = basePage;
  return {
    ...pageMemory,
    summary: resolvePageSummary(basePage, suggestion, existingPage),
    visualSummary: existingPage?.visualSummary,
    visualSummarySource: existingPage?.visualSummarySource,
    glossaryEntryIds: existingPage?.glossaryEntryIds,
    characterIds: resolvePageCharacterIds(
      suggestion,
      characterIndex,
      existingPage,
    ),
    updatedAt: now,
  };
}

export function upsertMemoryPage(
  memory: ChapterStoryMemory,
  page: PageStoryMemory,
  now: string,
): ChapterStoryMemory {
  const pages = memory.pages.filter((item) => item.pageId !== page.pageId);
  pages.push(page);
  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  return { ...memory, pages, updatedAt: now };
}

function resolvePageSummary(
  basePage: BasePageMemory,
  suggestion: AiPageSummarySuggestion,
  existingPage: PageStoryMemory | undefined,
): string {
  return (
    existingPage?.summary ||
    basePage.summary ||
    cleanText(suggestion.summary, 1200) ||
    basePage.translatedDigest ||
    basePage.sourceDigest
  );
}

function resolvePageCharacterIds(
  suggestion: AiPageSummarySuggestion,
  characterIndex: Map<string, string>,
  existingPage: PageStoryMemory | undefined,
): string[] | undefined {
  const suggestedIds = sanitizeList(suggestion.characterNames, 100, 200)
    .map((name) => characterIndex.get(normalizeKey(name)))
    .filter((id): id is string => Boolean(id));
  const mergedIds = [
    ...new Set([...(existingPage?.characterIds ?? []), ...suggestedIds]),
  ].slice(0, 100);
  return mergedIds.length > 0 ? mergedIds : undefined;
}
