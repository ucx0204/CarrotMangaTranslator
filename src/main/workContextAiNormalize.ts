import type {
  CharacterSpeechStyle,
  GlossaryEntryCategory,
  WorkTranslationRules,
} from "../shared/types";
import type {
  AiCharacterSuggestion,
  AiGlossarySuggestion,
  AiPageSummarySuggestion,
  AiWorkContextSuggestions,
} from "./workContextAiTypes";

const GLOSSARY_CATEGORIES: readonly GlossaryEntryCategory[] = [
  "character",
  "alias",
  "place",
  "term",
  "honorific",
  "other",
];

const SPEECH_STYLES: readonly CharacterSpeechStyle[] = [
  "neutral",
  "polite",
  "casual",
  "rough",
  "childish",
  "elderly",
  "formal",
  "custom",
];

export function normalizeAiWorkContextSuggestions(
  parsed: unknown,
): AiWorkContextSuggestions {
  const root = asRecord(parsed) ?? {};
  const payload = asRecord(root.suggestions) ?? root;
  return {
    glossary: toArray(payload.glossary).map(normalizeGlossarySuggestion),
    characters: toArray(payload.characters).map(normalizeCharacterSuggestion),
    rules: normalizeRules(payload.rules),
    pageSummaries: toArray(
      payload.pageSummaries ?? payload.page_summaries ?? payload.memory,
    ).map(normalizePageSummarySuggestion),
  };
}

function normalizeGlossarySuggestion(value: unknown): AiGlossarySuggestion {
  const record = asRecord(value);
  return {
    source: pickText(record, ["source", "original", "jp"], 400),
    target: pickText(record, ["target", "translation", "ko"], 400),
    category: parseGlossaryCategory(record?.category),
    aliases: pickList(record, ["aliases"], 50, 200),
    note: pickText(record, ["note", "reason"], 2000),
  };
}

function normalizeCharacterSuggestion(value: unknown): AiCharacterSuggestion {
  const record = asRecord(value);
  return {
    displayName: pickText(record, ["displayName", "display_name"], 200),
    sourceNames: pickList(record, ["sourceNames", "source_names"], 50, 200),
    targetName: pickText(record, ["targetName", "target_name"], 200),
    aliases: pickList(record, ["aliases"], 50, 200),
    speechStyle: parseSpeechStyle(record?.speechStyle ?? record?.speech_style),
    customSpeechStyle: pickText(
      record,
      ["customSpeechStyle", "custom_speech_style"],
      1000,
    ),
    note: pickText(record, ["note", "role", "relationship"], 2000),
  };
}

function normalizePageSummarySuggestion(
  value: unknown,
): AiPageSummarySuggestion {
  const record = asRecord(value);
  return {
    chapterId: pickText(record, ["chapterId", "chapter_id"], 200),
    pageId: pickText(record, ["pageId", "page_id"], 200),
    summary: pickText(record, ["summary"], 1200),
    characterNames: pickList(
      record,
      ["characterNames", "character_names", "characters"],
      100,
      200,
    ),
  };
}

function normalizeRules(
  value: unknown,
): Partial<WorkTranslationRules> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return compactRules({
    honorifics: parseRule(record.honorifics, ["preserve", "adapt", "drop"]),
    sfxMode: parseRule(record.sfxMode ?? record.sfx_mode, [
      "preserve",
      "translate",
      "note",
    ]),
    defaultTone: parseRule(record.defaultTone ?? record.default_tone, [
      "natural_korean",
      "literal",
    ]),
  });
}

function compactRules(rules: {
  honorifics?: WorkTranslationRules["honorifics"];
  sfxMode?: WorkTranslationRules["sfxMode"];
  defaultTone?: WorkTranslationRules["defaultTone"];
}): Partial<WorkTranslationRules> | undefined {
  const compact: Partial<WorkTranslationRules> = {};
  if (rules.honorifics) {
    compact.honorifics = rules.honorifics;
  }
  if (rules.sfxMode) {
    compact.sfxMode = rules.sfxMode;
  }
  if (rules.defaultTone) {
    compact.defaultTone = rules.defaultTone;
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function parseGlossaryCategory(
  value: unknown,
): GlossaryEntryCategory | undefined {
  return parseRule(value, GLOSSARY_CATEGORIES);
}

function parseSpeechStyle(value: unknown): CharacterSpeechStyle | undefined {
  return parseRule(value, SPEECH_STYLES);
}

function parseRule<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  const normalized = cleanText(value, 100);
  return allowed.includes(normalized as T) ? (normalized as T) : undefined;
}

function pickText(
  record: Record<string, unknown> | undefined,
  keys: string[],
  maxLength: number,
): string {
  for (const key of keys) {
    const value = cleanText(record?.[key], maxLength);
    if (value) {
      return value;
    }
  }
  return "";
}

function pickList(
  record: Record<string, unknown> | undefined,
  keys: string[],
  maxItems: number,
  maxLength: number,
): string[] {
  for (const key of keys) {
    const items = sanitizeList(record?.[key], maxItems, maxLength);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function sanitizeList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  return [
    ...new Map(
      toArray(value)
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean)
        .map((item) => [normalizeKey(item), item]),
    ).values(),
  ].slice(0, maxItems);
}

function cleanText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function normalizeKey(value: unknown): string {
  return cleanText(value, 400).toLocaleLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
