export type GlossaryEntryCategory =
  | "character"
  | "alias"
  | "place"
  | "term"
  // "sfx" is deprecated (handled by the sfxMode rule); kept for reading old data.
  | "sfx"
  | "honorific"
  | "other";

export type GlossaryEntry = {
  id: string;
  source: string;
  target: string;
  category: GlossaryEntryCategory;
  aliases?: string[];
  note?: string;
  origin?: "ai" | "manual";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CharacterSpeechStyle =
  | "neutral"
  | "polite"
  | "casual"
  | "rough"
  | "childish"
  | "elderly"
  | "formal"
  | "custom";

export type CharacterProfile = {
  id: string;
  displayName: string;
  sourceNames: string[];
  targetName: string;
  aliases?: string[];
  speechStyle: CharacterSpeechStyle;
  customSpeechStyle?: string;
  note?: string;
  origin?: "ai" | "manual";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WorkTranslationRules = {
  honorifics: "preserve" | "adapt" | "drop";
  sfxMode: "preserve" | "translate" | "note";
  defaultTone: "natural_korean" | "literal";
};

export type WorkStyleGuide = {
  schemaVersion: 1;
  workId: string;
  glossary: GlossaryEntry[];
  characters: CharacterProfile[];
  rules: WorkTranslationRules;
  createdAt: string;
  updatedAt: string;
};

export type PageStoryMemory = {
  pageId: string;
  pageName: string;
  pageIndex: number;
  sourceDigest: string;
  translatedDigest: string;
  summary: string;
  visualSummary?: string;
  visualSummarySource?: "ai" | "manual";
  glossaryEntryIds?: string[];
  characterIds?: string[];
  updatedAt: string;
};

export type ChapterStoryMemory = {
  schemaVersion: 1;
  workId: string;
  chapterId: string;
  pages: PageStoryMemory[];
  updatedAt: string;
  /** Set only by AI 용어/기억 analysis (not by translation-time memory writes). */
  aiAnalyzedAt?: string;
};

export type ResetWorkContextRequest = {
  /** Any chapter in the work whose complete term/memory context is reset. */
  chapterId: string;
};

export type ResetWorkContextResult = {
  styleGuide: WorkStyleGuide;
  /** Empty story memory for the chapter used to issue the request. */
  storyMemory: ChapterStoryMemory;
  resetChapterCount: number;
};

export type PromptWorkContext = {
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  recentPageCount: number;
};
