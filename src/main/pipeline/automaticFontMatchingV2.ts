import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import { FONT_MATCHING_SEMANTIC_ROLES } from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import { stripRichTextMarkup } from "../../shared/richTextMarkup";
import type { TranslationBlock } from "../../shared/textTypes";
import { resolveUiLocale } from "../../shared/uiLocales";
import { fontCandidateSupportsText } from "../fontCoverage";
import {
  resolveFontMatchingDecisionV2,
  type FontMatchingDecisionResultV2,
  type TranslationFontAssessmentV2,
} from "./fontMatchingDecisionV2";
import type { OverlayItem } from "./types";
import {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
} from "./automaticFontMatchingV2Catalog";
import { rankFontMatchingV2Candidates } from "./automaticFontMatchingV2Ranking";

export {
  FONT_MATCHING_V2_MODEL_VERSION,
  FONT_MATCHING_V2_RENDERER_HASH,
  resolveFontMatchingV2CatalogVersion,
} from "./automaticFontMatchingV2Catalog";

/**
 * These values identify the production font faces and renderer used to build
 * the first V2 prototype bank. A profile from a different bank must abstain
 * instead of silently applying stale font ids.
 */
const AUTOMATIC_CONFIDENCE_THRESHOLD = 0.86;

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

export type AutomaticFontOptionsV2 = Readonly<{
  enabled?: boolean;
  targetLanguage?: string;
  workId?: string;
  chapterId?: string;
  profile?: WorkTypographyProfileV2 | null;
  candidates?: readonly AutomaticFontCandidate[];
}>;

export type AutomaticFontDecisionV2 = Readonly<{
  result: FontMatchingDecisionResultV2;
  role: FontMatchRolePredictionV2;
  fontMetricWidthScale?: number;
}>;

export function resolveAutomaticFontDecisionV2({
  block,
  item,
  page,
  options,
  preserveExistingFont = false,
}: {
  block: TranslationBlock;
  item: OverlayItem;
  page: MangaPage;
  options: AutomaticFontOptionsV2;
  preserveExistingFont?: boolean;
}): AutomaticFontDecisionV2 | undefined {
  const runtime = resolveAutomaticFontRuntime(options, preserveExistingFont);
  if (!runtime) return undefined;
  const { candidates, chapterId, locale, profile, workId } = runtime;

  const role = resolveRolePrediction(item);
  const translatedText = stripRichTextMarkup(block.translatedText).trim();
  const rankedCandidates = rankFontMatchingV2Candidates({
    candidates,
    locale,
    profile,
    role,
    userDefaultFontId: block.fontFamily,
  });
  const translationAssessments = candidates.map((candidate) =>
    assessTranslation(candidate, translatedText),
  );
  const catalogVersion = resolveFontMatchingV2CatalogVersion(candidates);
  const result = resolveFontMatchingDecisionV2({
    workId,
    chapterId,
    pageId: page.id,
    blockId: block.id,
    role,
    treatment: { orientation: block.renderDirection },
    localEvidence: {
      rankedCandidates,
      // The semantic bootstrap has no source-pixel or measured renderer/layout
      // evidence. Keep its ranking for audit/suggestions, but never promote it
      // to an automatic font mutation.
      calibratedConfidence: 0,
      noneAcceptable: false,
      catalogVersion,
      modelVersion: FONT_MATCHING_V2_MODEL_VERSION,
      rendererHash: FONT_MATCHING_V2_RENDERER_HASH,
    },
    translationAssessments,
    profile,
    userDefaultCandidate: resolveUserDefaultCandidate(block, candidates),
    calibration: {
      minimumAutomaticConfidence: AUTOMATIC_CONFIDENCE_THRESHOLD,
      minimumRoleConfidence: 0.82,
      minimumIntentionalOverrideConfidence: 0.86,
      intentionalOverrideMinimumScoreMargin: 0.1,
    },
  });
  return buildAutomaticFontDecision(result, role, candidates);
}

function resolveAutomaticFontRuntime(
  options: AutomaticFontOptionsV2,
  preserveExistingFont: boolean,
) {
  // Keep mode owns the complete existing format, including an implicit
  // renderer default when fontFamily is absent. Existing formatting is not a
  // user-lock signal and must never be rewritten by automatic matching.
  if (!options.enabled || preserveExistingFont) return null;
  const locale = resolveUiLocale(options.targetLanguage);
  const candidates = options.candidates ?? [];
  if (!locale || candidates.length === 0) return null;
  return {
    candidates,
    locale,
    profile: options.profile ?? null,
    workId: options.workId ?? "unscoped-work",
    chapterId: options.chapterId ?? "unscoped-chapter",
  };
}

function resolveUserDefaultCandidate(
  block: TranslationBlock,
  candidates: readonly AutomaticFontCandidate[],
) {
  return block.fontFamily
    ? { fontId: block.fontFamily }
    : resolveCatalogDefault(candidates);
}

function buildAutomaticFontDecision(
  result: FontMatchingDecisionResultV2,
  role: FontMatchRolePredictionV2,
  candidates: readonly AutomaticFontCandidate[],
): AutomaticFontDecisionV2 {
  const selected = result.selectedStyle?.fontId;
  const candidate = selected
    ? candidates.find((entry) => entry.fontId === selected)
    : undefined;
  return {
    result,
    role,
    ...(candidate
      ? { fontMetricWidthScale: resolveCandidateWidthScale(candidate) }
      : {}),
  };
}

export function applyAutomaticFontDecisionV2(
  block: TranslationBlock,
  decision: AutomaticFontDecisionV2 | undefined,
): TranslationBlock {
  const selection = decision?.result.selectedStyle;
  if (!selection || decision?.result.decision.mode !== "apply") return block;
  return {
    ...block,
    fontFamily: selection.fontId,
    ...(selection.fontWeight === undefined
      ? {}
      : { bold: selection.fontWeight >= 600 }),
    ...(selection.italic === undefined ? {} : { italic: selection.italic }),
    ...(selection.outlineWidthScale === undefined
      ? {}
      : { outlineWidthScale: selection.outlineWidthScale }),
  };
}

function resolveRolePrediction(item: OverlayItem): FontMatchRolePredictionV2 {
  const rawRole = String(item.fontRole ?? "").trim();
  const primary = isSemanticRole(rawRole) ? rawRole : "unknown_needs_review";
  return {
    primary,
    confidence:
      primary === "unknown_needs_review"
        ? 0
        : clampProbability(item.fontRoleConfidence ?? 0),
    alternatives: [],
  };
}

function isSemanticRole(value: string): value is FontMatchingSemanticRole {
  return (FONT_MATCHING_SEMANTIC_ROLES as readonly string[]).includes(value);
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
  const widthScale = resolveCandidateWidthScale(candidate);
  const layoutScore = clampScore(0.08 - Math.abs(widthScale - 1) * 0.12);
  const glyphsRenderable = missingGlyphCount === 0;
  return {
    fontId: candidate.fontId,
    glyphCoverage,
    glyphsRenderable,
    missingGlyphCount,
    layoutScore,
    // `autoFitText` is a user layout preference, not evidence that a font is
    // impossible to lay out. Treating `false` as infeasible made V2 abstain on
    // every manually-sized block.
    layoutFeasible: glyphsRenderable,
  };
}

function resolveCatalogDefault(candidates: readonly AutomaticFontCandidate[]) {
  const candidate =
    candidates.find((entry) => entry.defaultFont) ??
    [...candidates].sort(
      (left, right) =>
        left.preferenceRank - right.preferenceRank ||
        compareStrings(left.fontId, right.fontId),
    )[0];
  return candidate ? { fontId: candidate.fontId } : null;
}

function resolveCandidateWidthScale(candidate: AutomaticFontCandidate): number {
  return WIDTH_CLASS_SCALE[Math.round(candidate.width)] ?? 1;
}

function clampProbability(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
