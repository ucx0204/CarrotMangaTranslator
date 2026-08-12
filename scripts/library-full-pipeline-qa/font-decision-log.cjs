"use strict";
/* eslint-disable complexity -- nullable fields mirror the complete runtime decision audit surface */

/**
 * @param {any} page
 * @param {any} trace
 * @param {{
 *   resolveEffectiveTextColor: (block: any) => string,
 *   resolveEffectiveTextOutlineColor: (block: any) => string,
 *   resolveEffectiveTextOutlineWidthScale: (block: any) => number,
 *   resolveTextOutlineContrastRatio: (textColor: string, outlineColor: string) => number,
 *   MIN_AUTOMATIC_TEXT_OUTLINE_CONTRAST_RATIO: number,
 * }} outlinePolicy
 */
function buildFontDecisionLog(page, trace, outlinePolicy) {
  const inferenceByBlockId = new Map(
    (trace?.pixelInference || []).map(
      /** @param {any} entry */ (entry) => [entry.blockId, entry],
    ),
  );
  return page.blocks.map(
    /** @param {any} block @param {number} blockIndex */ (
      block,
      blockIndex,
    ) => {
      const inference = inferenceByBlockId.get(block.id);
      const automatic = block.automaticFontMatch;
      const effectiveTextColor = outlinePolicy.resolveEffectiveTextColor(block);
      const effectiveOutlineColor =
        outlinePolicy.resolveEffectiveTextOutlineColor(block);
      const effectiveOutlineWidthScale =
        outlinePolicy.resolveEffectiveTextOutlineWidthScale(block);
      const effectiveOutlineContrastRatio =
        outlinePolicy.resolveTextOutlineContrastRatio(
          effectiveTextColor,
          effectiveOutlineColor,
        );
      const decision = {
        blockIndex,
        blockId: block.id,
        bbox: block.bbox,
        sourceText: block.sourceText,
        translatedText: block.translatedText,
        applied: Boolean(automatic),
        selectedFontId: automatic?.selectedFontId || null,
        effectiveFontFamily: block.fontFamily || null,
        effectiveOutlineWidthScale,
        effectiveTextColor,
        effectiveOutlineColor,
        effectiveOutlineContrastRatio,
        role:
          automatic?.role ||
          block.fontRole ||
          inference?.rolePrediction?.primary ||
          null,
        confidence: automatic?.confidence || null,
        source: automatic?.source || null,
        selectionCalibration: inference?.selectionCalibration || null,
        pageRelativeRoleQa: inference?.pageRelativeRoleQa || null,
        noneAcceptable: inference?.localEvidence?.noneAcceptable ?? null,
        localConfidence: inference?.localEvidence?.calibratedConfidence ?? null,
        top5: (inference?.localEvidence?.rankedCandidates || [])
          .slice(0, 5)
          .map(
            /** @param {any} candidate */ (candidate) => ({
              fontId: candidate.fontId,
              confidence: candidate.confidence,
              totalScore: candidate.totalScore,
              styleFit: candidate.styleFit,
              reasonCodes: candidate.reasonCodes,
            }),
          ),
      };
      assertAutomaticFontOutline(decision, outlinePolicy);
      return decision;
    },
  );
}

/** @param {any} decision @param {{ MIN_AUTOMATIC_TEXT_OUTLINE_CONTRAST_RATIO: number }} outlinePolicy */
function assertAutomaticFontOutline(decision, outlinePolicy) {
  if (!decision.applied) return;
  if (
    !Number.isFinite(decision.effectiveOutlineWidthScale) ||
    decision.effectiveOutlineWidthScale <= 0
  ) {
    throw new Error(
      `Applied automatic font removed the required text outline: ${decision.blockId}`,
    );
  }
  if (
    !Number.isFinite(decision.effectiveOutlineContrastRatio) ||
    decision.effectiveOutlineContrastRatio <
      outlinePolicy.MIN_AUTOMATIC_TEXT_OUTLINE_CONTRAST_RATIO
  ) {
    throw new Error(
      `Applied automatic font has insufficient text/outline contrast: ${decision.blockId}`,
    );
  }
}

module.exports = { buildFontDecisionLog };
