import type {
  ChapterStoryMemory,
  CharacterSpeechStyle,
  GlossaryEntryCategory,
  PageStoryMemory,
  WorkContextAnalysisCounts,
  WorkStyleGuide,
  WorkTranslationRules,
} from "../shared/types";

export type AiGlossarySuggestion = {
  source: string;
  target?: string;
  category?: GlossaryEntryCategory;
  aliases?: string[];
  note?: string;
};

export type AiCharacterSuggestion = {
  displayName?: string;
  sourceNames?: string[];
  targetName?: string;
  aliases?: string[];
  speechStyle?: CharacterSpeechStyle;
  customSpeechStyle?: string;
  note?: string;
};

export type AiPageSummarySuggestion = {
  chapterId?: string;
  pageId: string;
  summary?: string;
  characterNames?: string[];
};

export type AiWorkContextSuggestions = {
  glossary: AiGlossarySuggestion[];
  characters: AiCharacterSuggestion[];
  rules?: Partial<WorkTranslationRules>;
  pageSummaries: AiPageSummarySuggestion[];
};

export type BasePageMemory = PageStoryMemory & {
  workId: string;
  chapterId: string;
};

export type MergeAiWorkContextInput = {
  styleGuide: WorkStyleGuide;
  memories: ChapterStoryMemory[];
  basePages: BasePageMemory[];
  suggestions: AiWorkContextSuggestions;
  now?: string;
};

export type MergeAiWorkContextResult = {
  styleGuide: WorkStyleGuide;
  memories: ChapterStoryMemory[];
  counts: WorkContextAnalysisCounts;
  warnings: string[];
};
