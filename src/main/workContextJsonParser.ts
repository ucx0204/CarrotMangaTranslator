const JSON_KEY_NAMES = [
  "aliases",
  "category",
  "chapterId",
  "chapter_id",
  "characterNames",
  "character_names",
  "characters",
  "customSpeechStyle",
  "custom_speech_style",
  "defaultTone",
  "default_tone",
  "displayName",
  "display_name",
  "glossary",
  "honorifics",
  "memory",
  "note",
  "pageId",
  "pageSummaries",
  "page_id",
  "page_summaries",
  "rules",
  "sfxMode",
  "sfx_mode",
  "source",
  "sourceNames",
  "source_names",
  "speechStyle",
  "speech_style",
  "summary",
  "target",
  "targetName",
  "target_name",
];

const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;
const TRAILING_COMMA_PATTERN = /,\s*([}\]])/g;
const COMMENT_PATTERN = /(^|\s)\/\/.*(?=\r?\n|$)|\/\*[\s\S]*?\*\//g;
const SINGLE_QUOTED_VALUE_PATTERN = /:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g;
const SINGLE_QUOTED_ARRAY_VALUE_PATTERN =
  /((?:\[|,)\s*)'([^'\\]*(?:\\.[^'\\]*)*)'/g;
const LANGUAGE_PREFIX_PATTERN = /^(?:json|javascript|js)\s*\n/i;
// Gemma models sometimes emit reserved special tokens (e.g. `<unused49>`) into
// their text output, which corrupts the JSON and breaks the whole analysis.
const SPECIAL_TOKEN_PATTERN =
  /<\/?(?:unused\d+|start_of_turn|end_of_turn|eos|bos|pad|mask|unk)>/gi;

export function parseWorkContextModelJson(rawText: string): unknown {
  const candidate = extractJsonCandidate(
    rawText.replace(SPECIAL_TOKEN_PATTERN, ""),
  );
  const attempts = uniqueAttempts([
    candidate,
    stripLanguagePrefix(candidate),
    removeTrailingCommas(stripLanguagePrefix(candidate)),
    repairLooseJson(stripLanguagePrefix(candidate)),
  ]);

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch (_error) {
      // Try the next cleanup pass.
    }
  }

  throw new Error(tMain("workContext.errors.jsonRead"));
}

function extractJsonCandidate(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(FENCED_JSON_PATTERN);
  if (fenced?.[1]) {
    return stripLanguagePrefix(fenced[1].trim());
  }

  const balancedObject = extractBalancedJson(trimmed, "{", "}");
  if (balancedObject) {
    return balancedObject;
  }

  throw new Error(tMain("workContext.errors.jsonObjectMissing"));
}

function extractBalancedJson(
  text: string,
  openChar: string,
  closeChar: string,
): string | null {
  const start = text.indexOf(openChar);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function stripLanguagePrefix(value: string): string {
  return value.trim().replace(LANGUAGE_PREFIX_PATTERN, "").trim();
}

function removeTrailingCommas(value: string): string {
  return value.replace(TRAILING_COMMA_PATTERN, "$1");
}

function repairLooseJson(value: string): string {
  let repaired = stripLanguagePrefix(value)
    .replace(COMMENT_PATTERN, "")
    .replace(
      SINGLE_QUOTED_VALUE_PATTERN,
      (_match, content: string) =>
        `: ${JSON.stringify(content.replace(/\\'/g, "'"))}`,
    )
    .replace(
      SINGLE_QUOTED_ARRAY_VALUE_PATTERN,
      (_match, prefix: string, content: string) =>
        `${prefix}${JSON.stringify(content.replace(/\\'/g, "'"))}`,
    );

  for (const key of JSON_KEY_NAMES) {
    repaired = quoteLooseKey(repaired, key);
  }

  return removeTrailingCommas(repaired);
}

function quoteLooseKey(value: string, key: string): string {
  return value.replace(
    new RegExp(`([{,]\\s*)${escapeRegExp(key)}\\s*:`, "g"),
    `$1"${key}":`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueAttempts(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
import { tMain } from "./i18n";
