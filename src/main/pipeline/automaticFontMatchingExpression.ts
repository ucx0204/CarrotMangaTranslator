import type {
  FontStyleSelectionV2,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import {
  FONT_EXPRESSION_CONTRACT,
  FONT_EXPRESSION_CLASSES,
  FONT_EXPRESSION_MODEL_SHA256,
  type FontExpressionInference,
} from "./fontMatchingExpressionTypes";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import { hasVerifiedCrossScriptProxyInference } from "./automaticFontMatchingV2CrossScriptProxy";

const EXPRESSION_FONTS: Readonly<
  Record<string, { fontId: string; minimum: number }>
> = {
  heavy_sans: { fontId: "dohyeon", minimum: 0.6 },
};

/** A narrow source treatment preference; profile and manual precedence stay downstream. */
export function resolveFontExpressionSelection(
  expression: FontExpressionInference | undefined,
  candidates: readonly AutomaticFontCandidate[],
): FontStyleSelectionV2 | null {
  if (!validExpression(expression, FONT_EXPRESSION_MODEL_SHA256)) return null;
  const ranking = expression.probabilities
    .map((probability, index) => ({ probability, index }))
    .sort((a, b) => b.probability - a.probability || a.index - b.index);
  const best = ranking[0];
  const second = ranking[1];
  if (!best || !second) return null;
  const choice =
    EXPRESSION_FONTS[FONT_EXPRESSION_CLASSES[best.index] ?? "body"];
  if (
    !choice ||
    best.probability < choice.minimum ||
    best.probability - second.probability < 0.3
  )
    return null;
  const { fontId } = choice;
  if (!candidates.some((c) => c.fontId === fontId)) return null;
  return { fontId, fontWeight: 400, italic: false };
}

export function resolveAutomaticFontExpression(
  inference: VerifiedAutomaticFontPixelInferenceV2 | null,
  candidates: readonly AutomaticFontCandidate[],
) {
  if (!hasVerifiedCrossScriptProxyInference(inference, candidates)) return null;
  return resolveFontExpressionSelection(
    inference?.sourceExpression,
    candidates,
  );
}

export function applyFontExpressionRanking(
  ranked: readonly RankedFontCandidateV2[],
  selection: FontStyleSelectionV2 | null,
): readonly RankedFontCandidateV2[] {
  if (!selection || !ranked.some((c) => c.fontId === selection.fontId))
    return ranked;
  const preferred = ranked.find((c) => c.fontId === selection.fontId);
  if (!preferred || preferred.renderStatus !== "rendered") return ranked;
  const maximum = Math.max(0, ...ranked.map((c) => c.totalScore ?? 0));
  return [preferred, ...ranked.filter((c) => c !== preferred)].map(
    (candidate, index) => ({
      ...candidate,
      rank: index + 1,
      ...(index === 0
        ? {
            totalScore: maximum + 1,
            reasonCodes: [...candidate.reasonCodes, "source_ink_heavy_sans_v3"],
          }
        : {}),
    }),
  );
}

function validExpression(
  value: FontExpressionInference | undefined,
  expectedModelSha256: string,
): value is FontExpressionInference {
  if (
    !value ||
    value.contractVersion !== FONT_EXPRESSION_CONTRACT ||
    value.modelSha256 !== expectedModelSha256 ||
    !/^[a-f0-9]{64}$/u.test(expectedModelSha256) ||
    !Number.isInteger(value.componentCount) ||
    value.componentCount < 2 ||
    value.componentCount > 16 ||
    !Array.isArray(value.probabilities) ||
    value.probabilities.length !== FONT_EXPRESSION_CLASSES.length
  )
    return false;
  if (value.probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1))
    return false;
  return Math.abs(value.probabilities.reduce((a, b) => a + b, 0) - 1) < 0.0001;
}
