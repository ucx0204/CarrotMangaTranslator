import type { TFunction } from "i18next";
import type {
  CharacterProfile,
  CharacterSpeechStyle,
  GlossaryEntry,
  GlossaryEntryCategory,
  WorkStyleGuide,
} from "../../../../shared/workContextTypes";
import type {
  WorkContextBudgetOmittedPart,
  WorkContextBudgetPlan,
} from "../../../../shared/workContextBudget";

export const CATEGORY_IDS: GlossaryEntryCategory[] = [
  "character",
  "alias",
  "place",
  "term",
  "honorific",
  "other",
];

export const SPEECH_STYLE_IDS: CharacterSpeechStyle[] = [
  "neutral",
  "polite",
  "casual",
  "rough",
  "childish",
  "elderly",
  "formal",
  "custom",
];

export function formatTokenCount(
  tokens: number,
  locale: string,
  t: TFunction<"components">,
): string {
  return t("styleGuide.budget.tokenCount", {
    count: new Intl.NumberFormat(locale).format(
      Math.max(0, Math.round(tokens)),
    ),
  });
}

export function buildBudgetWarningText(
  budget: WorkContextBudgetPlan,
  locale: string,
  t: TFunction<"components">,
): string {
  const minimum = formatTokenCount(budget.minOutputHeadroomTokens, locale, t);
  const effective = t("styleGuide.budget.effectiveHeadroom", {
    tokens: formatTokenCount(budget.effective.outputHeadroomTokens, locale, t),
    percent: budget.effective.outputHeadroomPercent,
  });
  const omitted = formatOmittedParts(budget.omittedParts, t);
  return budget.effective.outputHeadroomTokens < budget.minOutputHeadroomTokens
    ? t("styleGuide.budget.warningInsufficient", {
        minimum,
        omitted,
        effective,
      })
    : t("styleGuide.budget.warningAdjusted", {
        minimum,
        omitted,
        effective,
      });
}

function formatOmittedParts(
  parts: WorkContextBudgetOmittedPart[],
  t: TFunction<"components">,
): string {
  return parts
    .map((part) => t(`styleGuide.budget.omittedParts.${part}`))
    .join(", ");
}

export function makeGlossaryEntry({
  source,
  target,
  category,
}: {
  source: string;
  target: string;
  category: GlossaryEntryCategory;
}): GlossaryEntry {
  const now = nowIso();
  return {
    id: makeLocalId("glossary"),
    source,
    target,
    category,
    aliases: [],
    note: "",
    enabled: true,
    origin: "manual",
    createdAt: now,
    updatedAt: now,
  };
}

export function makeCharacterProfile(): CharacterProfile {
  const now = nowIso();
  return {
    id: makeLocalId("character"),
    displayName: "",
    sourceNames: [],
    targetName: "",
    aliases: [],
    speechStyle: "neutral",
    customSpeechStyle: "",
    note: "",
    enabled: true,
    origin: "manual",
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeGuideForSave(guide: WorkStyleGuide): WorkStyleGuide {
  return {
    ...guide,
    glossary: guide.glossary.map(normalizeGlossaryEntry).filter(hasSource),
    characters: guide.characters
      .map(normalizeCharacter)
      .filter(hasCharacterIdentity)
      .map(fillCharacterDisplayName),
    updatedAt: nowIso(),
  };
}

function normalizeGlossaryEntry(entry: GlossaryEntry): GlossaryEntry {
  return {
    ...entry,
    source: entry.source.trim(),
    target: entry.target.trim(),
    aliases: normalizeTextList(entry.aliases ?? []),
    note: entry.note?.trim() ?? "",
  };
}

function hasSource(entry: GlossaryEntry): boolean {
  return Boolean(entry.source);
}

function normalizeCharacter(character: CharacterProfile): CharacterProfile {
  return {
    ...character,
    displayName: character.displayName.trim(),
    targetName: character.targetName.trim(),
    sourceNames: normalizeTextList(character.sourceNames),
    aliases: normalizeTextList(character.aliases ?? []),
    customSpeechStyle: character.customSpeechStyle?.trim() ?? "",
    note: character.note?.trim() ?? "",
  };
}

function hasCharacterIdentity(character: CharacterProfile): boolean {
  return Boolean(
    character.displayName ||
    character.targetName ||
    character.sourceNames.length,
  );
}

function fillCharacterDisplayName(
  character: CharacterProfile,
): CharacterProfile {
  return {
    ...character,
    displayName:
      character.displayName ||
      character.targetName ||
      character.sourceNames[0] ||
      "",
  };
}

function normalizeTextList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function splitList(value: string): string[] {
  return normalizeTextList(value.split(","));
}

export function nowIso(): string {
  return new Date().toISOString();
}

function makeLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
