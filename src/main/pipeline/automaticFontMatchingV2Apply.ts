import type { TranslationBlock } from "../../shared/textTypes";
import { resolveAutomaticTextOutlineWidthScale } from "../../shared/textOutline";
import type { AutomaticFontDecisionV2 } from "./automaticFontMatchingV2";

export function applyAutomaticFontDecisionV2(
  block: TranslationBlock,
  decision: AutomaticFontDecisionV2 | undefined,
): TranslationBlock {
  const selection = decision?.result.selectedStyle;
  if (!selection || decision?.result.decision.mode !== "apply") return block;
  const inverseTextStyle = decision.inverseTextStyle;
  return {
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
    outlineWidthScale: resolveAutomaticTextOutlineWidthScale(
      selection.outlineWidthScale ?? block.outlineWidthScale,
    ),
    ...(inverseTextStyle
      ? {
          textColor: inverseTextStyle.textColor,
          outlineColor: inverseTextStyle.outlineColor,
        }
      : {}),
    automaticFontMatch: buildAutomaticFontMatchRecord(block, decision),
  };
}

function buildAutomaticFontMatchRecord(
  block: TranslationBlock,
  decision: AutomaticFontDecisionV2,
): NonNullable<TranslationBlock["automaticFontMatch"]> {
  const selectedFontId = decision.result.selectedStyle?.fontId;
  if (!selectedFontId) {
    throw new Error("Applied automatic font decision requires a selection.");
  }
  return {
    schemaVersion: 1,
    selectedFontId,
    role: decision.role.primary,
    confidence: Math.min(
      decision.result.audit.localCalibratedConfidence,
      decision.result.audit.roleConfidence,
    ),
    source: resolveAutomaticFontMatchSource(decision),
    previousStyle: buildPreviousStyle(block, decision),
  };
}

function buildPreviousStyle(
  block: TranslationBlock,
  decision: AutomaticFontDecisionV2,
): NonNullable<TranslationBlock["automaticFontMatch"]>["previousStyle"] {
  const existingPrevious = block.automaticFontMatch?.previousStyle;
  return {
    ...resolvePreviousCoreStyle(block, existingPrevious),
    ...resolvePreviousColors(block, decision, existingPrevious),
  };
}

type PreviousStyle = NonNullable<
  TranslationBlock["automaticFontMatch"]
>["previousStyle"];

function resolvePreviousCoreStyle(
  block: TranslationBlock,
  existing: PreviousStyle | undefined,
): Pick<PreviousStyle, "fontFamily" | "bold" | "italic" | "outlineWidthScale"> {
  if (existing) {
    return {
      fontFamily: existing.fontFamily,
      bold: existing.bold,
      italic: existing.italic,
      outlineWidthScale: existing.outlineWidthScale,
    };
  }
  return {
    fontFamily: block.fontFamily ?? null,
    bold: block.bold ?? null,
    italic: block.italic ?? null,
    outlineWidthScale: block.outlineWidthScale ?? null,
  };
}

function resolvePreviousColors(
  block: TranslationBlock,
  decision: AutomaticFontDecisionV2,
  existing: PreviousStyle | undefined,
): Pick<PreviousStyle, "textColor" | "outlineColor"> {
  if (!decision.inverseTextStyle && !hasPreviousColors(existing)) return {};
  return {
    textColor: existing?.textColor ?? block.textColor,
    outlineColor: hasOwnOutlineColor(existing)
      ? existing.outlineColor
      : (block.outlineColor ?? null),
  };
}

function hasPreviousColors(existing: PreviousStyle | undefined): boolean {
  return Boolean(
    existing && ("textColor" in existing || "outlineColor" in existing),
  );
}

function hasOwnOutlineColor(
  existing: PreviousStyle | undefined,
): existing is PreviousStyle & { outlineColor: string | null } {
  return Boolean(existing && "outlineColor" in existing);
}

function resolveAutomaticFontMatchSource(
  decision: AutomaticFontDecisionV2,
): NonNullable<TranslationBlock["automaticFontMatch"]>["source"] {
  const usedEpisodePrior = decision.result.audit.priorityTrace.some((entry) =>
    entry.reasonCodes.includes("episode_body_consistency_prior"),
  );
  if (usedEpisodePrior) return "episode_consistency";
  if (
    decision.result.decision.resolvedBy === "block_user_lock" ||
    decision.result.decision.resolvedBy === "work_role_user_lock"
  ) {
    return "user_lock";
  }
  return decision.result.decision.resolvedBy === "work_profile"
    ? "work_profile"
    : "local_visual";
}
