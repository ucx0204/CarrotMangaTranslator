import { randomUUID } from "node:crypto";
import type {
  ChapterStoryMemory,
  CharacterProfile,
  CharacterSpeechStyle,
  GlossaryEntry,
  PageStoryMemory,
  WorkStyleGuide,
} from "../shared/workContextTypes";
import type { WorkContextAnalysisCounts } from "../shared/workContextAnalysisTypes";
import { tMain } from "./i18n";
import {
  cleanText,
  createEmptyCounts,
  mergeNote,
  normalizeKey,
  sanitizeList,
} from "./workContextAiMergeUtils";
import type {
  AiCharacterSuggestion,
  AiGlossarySuggestion,
  AiPageSummarySuggestion,
  AiWorkContextSuggestions,
  BasePageMemory,
  MergeAiWorkContextInput,
  MergeAiWorkContextResult,
} from "./workContextAiTypes";

export type { BasePageMemory } from "./workContextAiTypes";

export function mergeAiWorkContextSuggestions({
  styleGuide,
  memories,
  basePages,
  suggestions,
  now = new Date().toISOString(),
}: MergeAiWorkContextInput): MergeAiWorkContextResult {
  const counts = createEmptyCounts();
  const warnings: string[] = [];
  const withGlossary = mergeGlossary(styleGuide, suggestions, counts, now);
  const withCharacters = mergeCharacters(
    withGlossary,
    suggestions,
    counts,
    now,
  );
  const withRules = mergeRules(withCharacters, suggestions, counts, now);
  const nextMemories = mergeStoryMemories(
    memories,
    basePages,
    suggestions,
    withRules.characters,
    counts,
    warnings,
    now,
  );
  return {
    styleGuide: { ...withRules, updatedAt: now },
    memories: nextMemories,
    counts,
    warnings,
  };
}

function mergeGlossary(
  guide: WorkStyleGuide,
  suggestions: AiWorkContextSuggestions,
  counts: WorkContextAnalysisCounts,
  now: string,
): WorkStyleGuide {
  let glossary = guide.glossary;
  let index = buildGlossaryIndex(glossary);
  for (const suggestion of suggestions.glossary) {
    const source = cleanText(suggestion.source, 400);
    if (!source) {
      continue;
    }
    const matchId = index.get(normalizeKey(source));
    if (matchId) {
      glossary = updateGlossaryEntry(glossary, matchId, suggestion, now);
      counts.glossaryUpdated += 1;
    } else {
      glossary = [...glossary, makeGlossaryEntry(suggestion, now)];
      counts.glossaryAdded += 1;
    }
    index = buildGlossaryIndex(glossary);
  }
  return { ...guide, glossary };
}

function mergeCharacters(
  guide: WorkStyleGuide,
  suggestions: AiWorkContextSuggestions,
  counts: WorkContextAnalysisCounts,
  now: string,
): WorkStyleGuide {
  let characters = guide.characters;
  let index = buildCharacterIndex(characters);
  for (const suggestion of suggestions.characters) {
    const displayName = resolveCharacterDisplayName(suggestion);
    if (!displayName) {
      continue;
    }
    const matchId = resolveCharacterMatchId(index, suggestion, displayName);
    if (matchId) {
      characters = updateCharacterProfile(
        characters,
        matchId,
        suggestion,
        displayName,
        now,
      );
      counts.charactersUpdated += 1;
    } else {
      characters = [...characters, makeCharacterProfile(suggestion, now)];
      counts.charactersAdded += 1;
    }
    index = buildCharacterIndex(characters);
  }
  return { ...guide, characters };
}

function mergeRules(
  guide: WorkStyleGuide,
  suggestions: AiWorkContextSuggestions,
  counts: WorkContextAnalysisCounts,
  now: string,
): WorkStyleGuide {
  const rules = suggestions.rules;
  if (!rules) {
    return guide;
  }
  const nextRules = { ...guide.rules, ...rules };
  if (JSON.stringify(nextRules) !== JSON.stringify(guide.rules)) {
    counts.rulesUpdated = 1;
    return { ...guide, rules: nextRules, updatedAt: now };
  }
  return guide;
}

function mergeStoryMemories(
  memories: ChapterStoryMemory[],
  basePages: BasePageMemory[],
  suggestions: AiWorkContextSuggestions,
  characters: CharacterProfile[],
  counts: WorkContextAnalysisCounts,
  warnings: string[],
  now: string,
): ChapterStoryMemory[] {
  const pageIndex = new Map(basePages.map((page) => [page.pageId, page]));
  const memoryIndex = new Map(
    memories.map((memory) => [memory.chapterId, memory]),
  );
  const characterIndex = buildCharacterNameIndex(characters);
  for (const suggestion of suggestions.pageSummaries) {
    const basePage = pageIndex.get(suggestion.pageId);
    if (!basePage) {
      warnings.push(
        tMain("workContext.warnings.unknownPageId", {
          pageId: suggestion.pageId,
        }),
      );
      continue;
    }
    const memory = memoryIndex.get(basePage.chapterId);
    if (!memory) {
      continue;
    }
    memoryIndex.set(
      basePage.chapterId,
      upsertMemoryPage(
        memory,
        buildMergedPageMemory(basePage, suggestion, characterIndex, now),
        now,
      ),
    );
    counts.pageSummariesUpserted += 1;
  }
  // Every chapter included in this analysis run is now "AI 분석됨" — stamp the
  // marker so the "비어있는 화만" scope can skip them next time. This is the only
  // place aiAnalyzedAt is set; translation-time memory writes never touch it.
  return Array.from(memoryIndex.values())
    .map((memory) => ({ ...memory, aiAnalyzedAt: now }))
    .sort((left, right) => left.chapterId.localeCompare(right.chapterId));
}

function updateGlossaryEntry(
  glossary: GlossaryEntry[],
  id: string,
  suggestion: AiGlossarySuggestion,
  now: string,
): GlossaryEntry[] {
  return glossary.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          target: cleanText(suggestion.target, 400) || entry.target,
          category: suggestion.category ?? entry.category,
          aliases: mergeLists(entry.aliases, suggestion.aliases, 50),
          note: mergeNote(entry.note, suggestion.note),
          updatedAt: now,
        }
      : entry,
  );
}

function makeGlossaryEntry(
  suggestion: AiGlossarySuggestion,
  now: string,
): GlossaryEntry {
  return {
    id: `glossary-${randomUUID()}`,
    source: cleanText(suggestion.source, 400),
    target: cleanText(suggestion.target, 400),
    category: suggestion.category ?? "term",
    aliases: sanitizeList(suggestion.aliases, 50, 200),
    note: mergeNote("", suggestion.note),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function updateCharacterProfile(
  characters: CharacterProfile[],
  id: string,
  suggestion: AiCharacterSuggestion,
  displayName: string,
  now: string,
): CharacterProfile[] {
  return characters.map((character) =>
    character.id === id
      ? {
          ...character,
          displayName: character.displayName || displayName,
          sourceNames: mergeLists(
            character.sourceNames,
            suggestion.sourceNames,
            50,
          ),
          targetName:
            cleanText(suggestion.targetName, 200) || character.targetName,
          aliases: mergeLists(character.aliases, suggestion.aliases, 50),
          speechStyle: resolveSpeechStyleUpdate(character, suggestion),
          customSpeechStyle:
            cleanText(suggestion.customSpeechStyle, 1000) ||
            character.customSpeechStyle,
          note: mergeNote(character.note, suggestion.note),
          updatedAt: now,
        }
      : character,
  );
}

function makeCharacterProfile(
  suggestion: AiCharacterSuggestion,
  now: string,
): CharacterProfile {
  const displayName = resolveCharacterDisplayName(suggestion);
  return {
    id: `character-${randomUUID()}`,
    displayName,
    sourceNames: sanitizeList(suggestion.sourceNames, 50, 200),
    targetName: cleanText(suggestion.targetName, 200) || displayName,
    aliases: sanitizeList(suggestion.aliases, 50, 200),
    speechStyle: suggestion.speechStyle ?? "neutral",
    customSpeechStyle: cleanText(suggestion.customSpeechStyle, 1000),
    note: mergeNote("", suggestion.note),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function buildMergedPageMemory(
  basePage: BasePageMemory,
  suggestion: AiPageSummarySuggestion,
  characterIndex: Map<string, string>,
  now: string,
): PageStoryMemory {
  const { workId: _workId, chapterId: _chapterId, ...pageMemory } = basePage;
  const characterIds = sanitizeList(suggestion.characterNames, 100, 200)
    .map((name) => characterIndex.get(normalizeKey(name)))
    .filter((id): id is string => Boolean(id));
  return {
    ...pageMemory,
    summary:
      cleanText(suggestion.summary, 1200) ||
      basePage.summary ||
      basePage.translatedDigest ||
      basePage.sourceDigest,
    characterIds:
      characterIds.length > 0 ? [...new Set(characterIds)] : undefined,
    updatedAt: now,
  };
}

function upsertMemoryPage(
  memory: ChapterStoryMemory,
  page: PageStoryMemory,
  now: string,
): ChapterStoryMemory {
  const pages = memory.pages.filter((item) => item.pageId !== page.pageId);
  pages.push(page);
  pages.sort((left, right) => left.pageIndex - right.pageIndex);
  return { ...memory, pages, updatedAt: now };
}

function buildGlossaryIndex(glossary: GlossaryEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of glossary) {
    for (const key of [entry.source, ...(entry.aliases ?? [])]) {
      const normalized = normalizeKey(key);
      if (normalized) {
        index.set(normalized, entry.id);
      }
    }
  }
  return index;
}

function buildCharacterIndex(
  characters: CharacterProfile[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const character of characters) {
    for (const key of collectCharacterNames(character)) {
      const normalized = normalizeKey(key);
      if (normalized) {
        index.set(normalized, character.id);
      }
    }
  }
  return index;
}

function buildCharacterNameIndex(
  characters: CharacterProfile[],
): Map<string, string> {
  return buildCharacterIndex(characters);
}

function resolveCharacterMatchId(
  index: Map<string, string>,
  suggestion: AiCharacterSuggestion,
  displayName: string,
): string | undefined {
  for (const key of [
    displayName,
    suggestion.targetName,
    ...(suggestion.sourceNames ?? []),
    ...(suggestion.aliases ?? []),
  ]) {
    const id = index.get(normalizeKey(key));
    if (id) {
      return id;
    }
  }
  return undefined;
}

function collectCharacterNames(character: CharacterProfile): string[] {
  return [
    character.displayName,
    character.targetName,
    ...character.sourceNames,
    ...(character.aliases ?? []),
  ];
}

function resolveCharacterDisplayName(
  suggestion: AiCharacterSuggestion,
): string {
  return (
    cleanText(suggestion.displayName, 200) ||
    cleanText(suggestion.targetName, 200) ||
    cleanText(suggestion.sourceNames?.[0], 200)
  );
}

function resolveSpeechStyleUpdate(
  character: CharacterProfile,
  suggestion: AiCharacterSuggestion,
): CharacterSpeechStyle {
  if (!suggestion.speechStyle) {
    return character.speechStyle;
  }
  if (
    character.speechStyle === "neutral" ||
    suggestion.speechStyle === "custom"
  ) {
    return suggestion.speechStyle;
  }
  return character.speechStyle;
}

function mergeLists(
  current: string[] | undefined,
  next: string[] | undefined,
  maxItems: number,
): string[] {
  return sanitizeList([...(current ?? []), ...(next ?? [])], maxItems, 200);
}
