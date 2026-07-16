import type { MangaPage } from "../shared/libraryTypes";
import type { PageStoryMemory } from "../shared/workContextTypes";
import type {
  WorkContextUsage,
  WorkContextUsageLastSeen,
  WorkContextUsageMetric,
} from "../shared/workContextUsageTypes";
import {
  getChapterStoryMemory,
  getWorkStyleGuide,
  listLibrary,
  openChapter,
} from "./library";

type MutableMetric = WorkContextUsageMetric;
type UsageMatcher = { id: string; keys: string[] };

export async function buildWorkContextUsage(
  workId: string,
): Promise<WorkContextUsage> {
  const [library, guide] = await Promise.all([
    listLibrary(),
    getWorkStyleGuide(workId),
  ]);
  const work = library.works.find((candidate) => candidate.id === workId);
  const glossary = new Map<string, MutableMetric>(
    guide.glossary.map((entry) => [entry.id, emptyMetric(entry.id)]),
  );
  const characters = new Map<string, MutableMetric>(
    guide.characters.map((entry) => [entry.id, emptyMetric(entry.id)]),
  );
  const glossaryMatchers = guide.glossary.map((entry) =>
    makeUsageMatcher(entry.id, [entry.source, ...(entry.aliases ?? [])]),
  );
  const characterMatchers = guide.characters.map((entry) =>
    makeUsageMatcher(entry.id, [
      ...entry.sourceNames,
      ...(entry.aliases ?? []),
    ]),
  );
  if (!work) {
    return {
      workId,
      glossary: [...glossary.values()],
      characters: [...characters.values()],
    };
  }

  const chapters = await Promise.all(
    work.chapters.map(async (chapterSummary) => {
      const [chapter, memory] = await Promise.all([
        openChapter(chapterSummary.id),
        getChapterStoryMemory(chapterSummary.id),
      ]);
      return { chapter, memory };
    }),
  );
  for (const [chapterIndex, { chapter, memory }] of chapters.entries()) {
    const memoriesByPageId = new Map(
      memory.pages.map((pageMemory) => [pageMemory.pageId, pageMemory]),
    );
    for (const [pageIndex, page] of chapter.pages.entries()) {
      collectPageUsage({
        page,
        pageMemory: memoriesByPageId.get(page.id),
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chapterIndex,
        pageIndex,
        glossaryMatchers,
        characterMatchers,
        glossary,
        characters,
      });
    }
  }

  return {
    workId,
    glossary: [...glossary.values()],
    characters: [...characters.values()],
  };
}

function collectPageUsage({
  page,
  pageMemory,
  chapterId,
  chapterTitle,
  chapterIndex,
  pageIndex,
  glossaryMatchers,
  characterMatchers,
  glossary,
  characters,
}: {
  page: MangaPage;
  pageMemory?: PageStoryMemory;
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  pageIndex: number;
  glossaryMatchers: UsageMatcher[];
  characterMatchers: UsageMatcher[];
  glossary: Map<string, MutableMetric>;
  characters: Map<string, MutableMetric>;
}): void {
  const sourceText = normalizeMatchText(
    page.blocks.map((block) => block.sourceText).join("\n"),
  );
  const lastSeen: WorkContextUsageLastSeen = {
    chapterId,
    chapterTitle,
    chapterIndex,
    pageId: page.id,
    pageName: page.name,
    pageIndex,
  };
  const glossaryEvidence = new Set(pageMemory?.glossaryEntryIds ?? []);
  const characterEvidence = new Set(pageMemory?.characterIds ?? []);

  collectGlossaryUsage({
    matchers: glossaryMatchers,
    evidence: glossaryEvidence,
    lastSeen,
    metrics: glossary,
    sourceText,
  });
  collectCharacterUsage({
    matchers: characterMatchers,
    evidence: characterEvidence,
    lastSeen,
    metrics: characters,
    page,
    sourceText,
  });
}

function collectGlossaryUsage({
  matchers,
  evidence,
  lastSeen,
  metrics,
  sourceText,
}: {
  matchers: UsageMatcher[];
  evidence: Set<string>;
  lastSeen: WorkContextUsageLastSeen;
  metrics: Map<string, MutableMetric>;
  sourceText: string;
}): void {
  for (const matcher of matchers) {
    const mentionCount = countNormalizedMentions(sourceText, matcher.keys);
    if (mentionCount > 0 || evidence.has(matcher.id)) {
      recordPage(metrics.get(matcher.id), mentionCount, lastSeen);
    }
  }
}

function collectCharacterUsage({
  matchers,
  evidence,
  lastSeen,
  metrics,
  page,
  sourceText,
}: {
  matchers: UsageMatcher[];
  evidence: Set<string>;
  lastSeen: WorkContextUsageLastSeen;
  metrics: Map<string, MutableMetric>;
  page: MangaPage;
  sourceText: string;
}): void {
  for (const matcher of matchers) {
    const mentionCount = countNormalizedMentions(sourceText, matcher.keys);
    const speakerMatch = page.blocks.some(
      (block) => block.speakerId === matcher.id,
    );
    if (mentionCount > 0 || speakerMatch || evidence.has(matcher.id)) {
      recordPage(metrics.get(matcher.id), mentionCount, lastSeen);
    }
  }
}

function emptyMetric(id: string): MutableMetric {
  return { id, pageCount: 0, mentionCount: 0 };
}

function recordPage(
  metric: MutableMetric | undefined,
  mentionCount: number,
  lastSeen: WorkContextUsageLastSeen,
): void {
  if (!metric) return;
  metric.pageCount += 1;
  metric.mentionCount += Math.max(0, mentionCount);
  metric.lastSeen = lastSeen;
}

export function countTextMentions(text: string, rawKeys: string[]): number {
  const normalizedText = normalizeMatchText(text);
  const keys = normalizeMatchKeys(rawKeys);
  return countNormalizedMentions(normalizedText, keys);
}

function countNormalizedMentions(
  normalizedText: string,
  keys: string[],
): number {
  if (!normalizedText || keys.length === 0) return 0;
  if (keys.length === 1) {
    return countSingleKeyMentions(normalizedText, keys[0]);
  }
  const occupied = new Uint8Array(normalizedText.length);
  let count = 0;
  for (const key of keys) {
    let fromIndex = 0;
    while (fromIndex < normalizedText.length) {
      const index = normalizedText.indexOf(key, fromIndex);
      if (index < 0) break;
      const end = index + key.length;
      const overlaps = occupied.subarray(index, end).includes(1);
      if (!overlaps) {
        occupied.fill(1, index, end);
        count += 1;
      }
      fromIndex = index + Math.max(1, key.length);
    }
  }
  return count;
}

function countSingleKeyMentions(text: string, key: string): number {
  let count = 0;
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const index = text.indexOf(key, fromIndex);
    if (index < 0) break;
    count += 1;
    fromIndex = index + Math.max(1, key.length);
  }
  return count;
}

function makeUsageMatcher(id: string, rawKeys: string[]): UsageMatcher {
  return { id, keys: normalizeMatchKeys(rawKeys) };
}

function normalizeMatchKeys(rawKeys: string[]): string[] {
  return [...new Set(rawKeys.map(normalizeMatchText).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
}

function normalizeMatchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
