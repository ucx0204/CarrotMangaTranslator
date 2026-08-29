import type {
  CharacterSpeechStyle,
  GlossaryEntryCategory,
} from "../shared/workContextTypes";

export type JsonRecord = Record<string, unknown>;

export function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function readAction(
  value: unknown,
): "add" | "update" | "disable" | null {
  return value === "add" || value === "update" || value === "disable"
    ? value
    : null;
}

export function readGlossaryCategory(
  value: unknown,
): GlossaryEntryCategory | null {
  return ["character", "alias", "place", "term", "honorific", "other"].includes(
    String(value),
  )
    ? (value as GlossaryEntryCategory)
    : null;
}

export function readSpeechStyle(value: unknown): CharacterSpeechStyle | null {
  return [
    "neutral",
    "polite",
    "casual",
    "rough",
    "childish",
    "elderly",
    "formal",
    "custom",
  ].includes(String(value))
    ? (value as CharacterSpeechStyle)
    : null;
}

export function readOptionalArrayField(
  record: JsonRecord | null,
  key: string,
  fallback: string[] | undefined,
  maximumItems: number,
  maximumLength: number,
): { [key: string]: string[] } | Record<string, never> {
  const value = record?.[key];
  const resolved =
    value === undefined
      ? fallback
      : readStringArray(value, maximumItems, maximumLength);
  return resolved?.length ? { [key]: resolved } : {};
}

export function readOptionalField(
  record: JsonRecord | null,
  key: string,
  fallback: string | undefined,
  maximumLength: number,
): { [key: string]: string } | Record<string, never> {
  const value = record?.[key] === undefined ? fallback : record[key];
  const resolved = readString(value, maximumLength);
  return resolved ? { [key]: resolved } : {};
}

export function readOptionalString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : readString(value, maximumLength);
}

export function readStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.flatMap((candidate) => {
      const text = readString(candidate, maximumLength);
      return text ? [text] : [];
    }),
  ).slice(0, maximumItems);
}

export function readString(value: unknown, maximumLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maximumLength)
    : "";
}

export function canonicalizeHttpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    return url.protocol === "https:" ? url.href : "";
  } catch (_error) {
    return "";
  }
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
