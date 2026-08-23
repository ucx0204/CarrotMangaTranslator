import type { WorkStyleGuide } from "./workContextTypes";

const PUNCTUATION_EQUIVALENTS = [
  [".", "。", "．"],
  [",", "、", "，"],
  ["!", "！"],
  ["?", "？"],
  [":", "："],
  [";", "；"],
  ["…", "⋯"],
] as const;

export type GlossaryOmissionResult = Readonly<{
  matchedTerms: readonly string[];
  text: string;
}>;

export function collectGlossaryOmissionTerms(
  guide: Pick<WorkStyleGuide, "glossary">,
): string[] {
  return normalizeGlossaryOmissionTerms(
    guide.glossary.flatMap((entry) =>
      entry.enabled !== false && !String(entry.target ?? "").trim()
        ? [entry.source, ...(entry.aliases ?? [])]
        : [],
    ),
  );
}

function normalizeGlossaryOmissionTerms(values: readonly unknown[]): string[] {
  const unique = new Set(
    values.map((value) => String(value ?? "").trim()).filter(Boolean),
  );
  return [...unique].sort(
    (left, right) =>
      [...right].length - [...left].length || left.localeCompare(right),
  );
}

export function omitGlossaryTermsFromSource(
  sourceText: string,
  rawTerms: readonly unknown[],
): GlossaryOmissionResult {
  const terms = normalizeGlossaryOmissionTerms(rawTerms);
  if (!sourceText || terms.length === 0) {
    return { matchedTerms: [], text: sourceText };
  }
  const matchedTerms: string[] = [];
  let cursor = 0;
  let output = "";
  while (cursor < sourceText.length) {
    const matched = terms.find((term) => sourceText.startsWith(term, cursor));
    if (!matched) {
      output += sourceText[cursor];
      cursor += 1;
      continue;
    }
    matchedTerms.push(matched);
    cursor += matched.length;
  }
  return {
    matchedTerms,
    text: cleanOmittedSourceSpacing(output),
  };
}

export function applyGlossaryOmissionToTranslation({
  sourceText,
  translatedText,
  terms,
}: {
  sourceText: string;
  translatedText: string;
  terms: readonly unknown[];
}): string {
  const omitted = omitGlossaryTermsFromSource(sourceText, terms);
  if (omitted.matchedTerms.length === 0) return translatedText;
  if (!omitted.text.trim()) return "";

  const trimmedSource = sourceText.trimEnd();
  const trailingTerm = omitted.matchedTerms.find((term) =>
    trimmedSource.endsWith(term),
  );
  return trailingTerm
    ? removeOneEquivalentTrailingPunctuation(translatedText, trailingTerm)
    : translatedText;
}

function cleanOmittedSourceSpacing(value: string): string {
  return value
    .replace(/[\t ]{2,}/g, " ")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .trim();
}

function removeOneEquivalentTrailingPunctuation(
  translatedText: string,
  sourceTerm: string,
): string {
  const sourcePunctuation = [...sourceTerm].at(-1);
  const equivalents = PUNCTUATION_EQUIVALENTS.find((group) =>
    group.some((value) => value === sourcePunctuation),
  );
  if (!equivalents) return translatedText;

  const characters = [...translatedText];
  let index = characters.length - 1;
  while (index >= 0 && /\s/u.test(characters[index] ?? "")) index -= 1;
  if (index < 0 || !equivalents.some((value) => value === characters[index])) {
    return translatedText;
  }
  characters.splice(index, 1);
  return characters.join("").trimEnd();
}
