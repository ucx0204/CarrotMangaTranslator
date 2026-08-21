import type { TranslationBlock } from "../../shared/textTypes";
import {
  resolveAutomaticTextOutlineColor,
  resolveEffectiveTextOutlineWidthPx,
} from "../../shared/textOutline";
import type { AutomaticFontDecisionV2 } from "./automaticFontMatchingV2";

export function applyAutomaticFontDecisionV2(
  block: TranslationBlock,
  decision: AutomaticFontDecisionV2 | undefined,
): TranslationBlock {
  const selection = decision?.result.selectedStyle;
  if (!selection || decision?.result.decision.mode !== "apply") return block;
  const inverseTextStyle = decision.inverseTextStyle;
  const applied: TranslationBlock = {
    ...block,
    ...(block.fontRole === undefined
      ? {
          fontRole: decision.role.primary,
          fontRoleConfidence: decision.role.confidence,
        }
      : {}),
    fontFamily: selection.fontId,
    ...(selection.fontWeight === undefined
      ? {}
      : { bold: selection.fontWeight >= 600 }),
    ...(selection.italic === undefined ? {} : { italic: selection.italic }),
    // Font matching may choose a face and source-polarity colors, but outline
    // thickness belongs to the user's block/default formatting. In particular,
    // never let a learned/profile selection replace it with a legacy scale.
    ...(inverseTextStyle
      ? {
          textColor: inverseTextStyle.textColor,
          outlineColor: inverseTextStyle.outlineColor,
        }
      : {}),
  };
  if (resolveEffectiveTextOutlineWidthPx(applied, applied.fontSizePx) <= 0) {
    return applied;
  }
  return {
    ...applied,
    outlineColor: resolveAutomaticTextOutlineColor(applied),
  };
}
