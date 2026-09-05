import type {
  RankedFontCandidateV2,
  FontMatchRolePredictionV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { UiLocale } from "../../shared/uiLocales";
import type { TranslationBlock } from "../../shared/textTypes";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import { FONT_CATALOG_REVISION } from "./fontMatchingCatalogRevision";
import { hasVerifiedCrossScriptProxyInference } from "./automaticFontMatchingV2CrossScriptProxy";
import { rankFontMatchingV2Candidates } from "./automaticFontMatchingV2Ranking";

export function resolveFontPaletteEvidence(options: {
  originalCandidates: readonly RankedFontCandidateV2[];
  candidates: readonly AutomaticFontCandidate[];
  locale: UiLocale;
  role: FontMatchRolePredictionV2;
  block: TranslationBlock;
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null;
}) {
  const {
    originalCandidates,
    candidates,
    locale,
    role,
    block,
    pixelInference,
  } = options;
  return pixelInference?.catalogRevision === FONT_CATALOG_REVISION
    ? projectFontPaletteEvidence(
        originalCandidates,
        candidates,
        locale,
        role,
        block.fontFamily,
        hasVerifiedCrossScriptProxyInference(pixelInference, candidates),
      )
    : originalCandidates;
}

function projectFontPaletteEvidence(
  original: readonly RankedFontCandidateV2[],
  candidates: readonly AutomaticFontCandidate[],
  locale: UiLocale,
  role: FontMatchRolePredictionV2,
  userDefaultFontId: string | undefined,
  hasProxy: boolean,
): readonly RankedFontCandidateV2[] {
  const ids = new Set(candidates.map((candidate) => candidate.fontId));
  const retained = original.filter((candidate) => ids.has(candidate.fontId));
  const known = new Set(retained.map((candidate) => candidate.fontId));
  const added = rankFontMatchingV2Candidates({
    candidates,
    locale,
    role,
    profile: null,
    userDefaultFontId,
  })
    .filter((candidate) => !known.has(candidate.fontId))
    .map((candidate) => ({
      ...candidate,
      totalScore: -1,
      confidence: 0,
      ...(hasProxy
        ? {}
        : {
            renderStatus: "unrenderable" as const,
            unrenderableReason: "font_reference_requires_proxy",
          }),
    }));
  return [...retained, ...added].map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}
