export type GlossaryEntryCategory =
  | "character"
  | "alias"
  | "place"
  | "term"
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
  characterIds?: string[];
  updatedAt: string;
};

export type ChapterStoryMemory = {
  schemaVersion: 1;
  workId: string;
  chapterId: string;
  pages: PageStoryMemory[];
  updatedAt: string;
};

export type PromptWorkContext = {
  styleGuide: WorkStyleGuide;
  storyMemory: ChapterStoryMemory;
  recentPageCount: number;
};
