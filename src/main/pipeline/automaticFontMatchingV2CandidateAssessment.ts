import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import { stripRichTextMarkup } from "../../shared/richTextMarkup";
import { fontCandidateSupportsText } from "../fontCoverage";
import type { TranslationFontAssessmentV2 } from "./fontMatchingDecisionV2";

const WIDTH_CLASS_SCALE: Readonly<Record<number, number>> = {
  1: 0.5,
  2: 0.625,
  3: 0.75,
  4: 0.875,
  5: 1,
  6: 1.125,
  7: 1.25,
  8: 1.5,
  9: 2,
};

export function assessAutomaticFontTranslations(
  candidates: readonly AutomaticFontCandidate[],
  translatedText: string,
): readonly TranslationFontAssessmentV2[] {
  const text = stripRichTextMarkup(translatedText).trim();
  return candidates.map((candidate) => assessTranslation(candidate, text));
}

export function resolveAutomaticFontCandidateWidthScale(
  candidate: AutomaticFontCandidate,
): number {
  return WIDTH_CLASS_SCALE[Math.round(candidate.width)] ?? 1;
}

function assessTranslation(
  candidate: AutomaticFontCandidate,
  translatedText: string,
): TranslationFontAssessmentV2 {
  const visibleCharacters = [...translatedText].filter(
    (character) => !/^\s$/u.test(character),
  );
  const missingGlyphCount = visibleCharacters.filter(
    (character) => !fontCandidateSupportsText(candidate, character),
  ).length;
  const glyphCoverage =
    visibleCharacters.length === 0
      ? 1
      : (visibleCharacters.length - missingGlyphCount) /
        visibleCharacters.length;
  const widthScale = resolveAutomaticFontCandidateWidthScale(candidate);
  const glyphsRenderable = missingGlyphCount === 0;
  return {
    fontId: candidate.fontId,
    glyphCoverage,
    glyphsRenderable,
    missingGlyphCount,
    layoutScore: clampScore(0.08 - Math.abs(widthScale - 1) * 0.12),
    // `autoFitText` is a preference, not proof that layout is impossible.
    layoutFeasible: glyphsRenderable,
  };
}

function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
