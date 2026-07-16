import type {
  PageContextCharacterCandidate,
  PageContextGlossaryCandidate,
  PageContextPayload,
} from "./types";

const OPEN_TAG_PATTERN = /<page-context\b[^>]*>/i;
const CLOSE_TAG_PATTERN = /<\/page-context\s*>/i;
const GLOSSARY_CATEGORIES = new Set([
  "character",
  "alias",
  "place",
  "term",
  "honorific",
  "other",
]);
const SPEECH_STYLES = new Set([
  "neutral",
  "polite",
  "casual",
  "rough",
  "childish",
  "elderly",
  "formal",
  "custom",
]);

export type ExtractedPageContext = {
  overlayText: string;
  pageContext?: PageContextPayload;
  status: "missing" | "invalid" | "parsed";
};

/**
 * Removes the optional context trailer before the legacy overlay parser sees
 * the response. An unterminated trailer is assumed to run to EOF because the
 * contract always places it after overlay records.
 */
export function extractPageContextResponse(
  rawText: string,
): ExtractedPageContext {
  const openMatch = OPEN_TAG_PATTERN.exec(rawText);
  if (!openMatch || openMatch.index === undefined) {
    return {
      overlayText: rawText.replace(CLOSE_TAG_PATTERN, ""),
      status: "missing",
    };
  }

  const contentStart = openMatch.index + openMatch[0].length;
  const afterOpen = rawText.slice(contentStart);
  const closeMatch = CLOSE_TAG_PATTERN.exec(afterOpen);
  const contentEnd = closeMatch?.index ?? afterOpen.length;
  const suffix = closeMatch
    ? afterOpen.slice(contentEnd + closeMatch[0].length)
    : "";
  const overlayText = `${rawText.slice(0, openMatch.index)}${suffix}`.trim();
  const parsed = parsePageContextJson(afterOpen.slice(0, contentEnd));
  return parsed
    ? { overlayText, pageContext: parsed, status: "parsed" }
    : { overlayText, status: "invalid" };
}

function parsePageContextJson(rawJson: string): PageContextPayload | null {
  const candidate = rawJson
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!candidate) {
    return null;
  }
  try {
    return buildPageContextPayload(JSON.parse(candidate) as unknown);
  } catch (_error) {
    // error-policy-allow: optional page-context JSON never invalidates a valid translation.
    return null;
  }
}

function buildPageContextPayload(raw: unknown): PageContextPayload | null {
  if (!isRecord(raw) || !isOptionalString(raw.visualSummary)) {
    return null;
  }
  const glossary = readCandidateArray(raw, "glossary", "glossaryCandidates");
  const characters = readCandidateArray(
    raw,
    "characters",
    "characterCandidates",
  );
  if (!glossary || !characters) {
    return null;
  }
  return {
    visualSummary: cleanText(raw.visualSummary, 1200) || undefined,
    glossary: readGlossaryCandidates(glossary),
    characters: readCharacterCandidates(characters),
  };
}

function readCandidateArray(
  raw: Record<string, unknown>,
  key: string,
  legacyKey: string,
): unknown[] | null {
  const value = raw[key] ?? raw[legacyKey] ?? [];
  return Array.isArray(value) ? value : null;
}

function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function readGlossaryCandidates(
  value: unknown,
): PageContextGlossaryCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: PageContextGlossaryCandidate[] = [];
  for (const item of value.slice(0, 100)) {
    if (!isRecord(item)) {
      continue;
    }
    const source = cleanText(item.source, 400);
    if (!source) {
      continue;
    }
    const rawCategory = cleanText(item.category, 40);
    const category = GLOSSARY_CATEGORIES.has(rawCategory)
      ? (rawCategory as PageContextGlossaryCandidate["category"])
      : "term";
    candidates.push({
      source,
      target: cleanText(item.target, 400),
      category,
      aliases: readTextList(item.aliases, 50, 200),
      note: cleanText(item.note, 2000) || undefined,
    });
  }
  return candidates;
}

function readCharacterCandidates(
  value: unknown,
): PageContextCharacterCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: PageContextCharacterCandidate[] = [];
  for (const item of value.slice(0, 100)) {
    if (!isRecord(item)) {
      continue;
    }
    const sourceNames = readTextList(item.sourceNames, 50, 200);
    const targetName = cleanText(item.targetName, 200);
    const displayName =
      cleanText(item.displayName, 200) || targetName || sourceNames[0] || "";
    if (!displayName) {
      continue;
    }
    const rawSpeechStyle = cleanText(item.speechStyle, 40);
    const speechStyle = SPEECH_STYLES.has(rawSpeechStyle)
      ? (rawSpeechStyle as PageContextCharacterCandidate["speechStyle"])
      : undefined;
    candidates.push({
      displayName,
      sourceNames,
      targetName: targetName || displayName,
      aliases: readTextList(item.aliases, 50, 200),
      speechStyle,
      customSpeechStyle: cleanText(item.customSpeechStyle, 1000) || undefined,
      note: cleanText(item.note, 2000) || undefined,
    });
  }
  return candidates;
}

function readTextList(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .slice(0, maxItems)
        .map((item) => cleanText(item, maxChars))
        .filter(Boolean),
    ),
  ];
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
