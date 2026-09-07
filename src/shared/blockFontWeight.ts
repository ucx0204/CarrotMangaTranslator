import type { TranslationBlock } from "./textTypes";

/** Legacy projects keep 400/800; an automatic choice retains its exact face. */
export function resolveFontWeight(style: {
  bold?: boolean;
  fontWeight?: number;
}): number {
  const weight = normalizeFontWeight(style.fontWeight);
  return weight !== undefined && weight >= 600 === Boolean(style.bold)
    ? weight
    : style.bold
      ? 800
      : 400;
}

export function normalizeFontWeight(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 900
    ? value
    : undefined;
}

/** Explicit face/weight copies survive; manual family or bold edits replace it. */
export function normalizeFontWeightPatch(
  patch: Partial<TranslationBlock>,
): Partial<TranslationBlock> {
  return !Object.hasOwn(patch, "fontWeight") &&
    (Object.hasOwn(patch, "bold") || Object.hasOwn(patch, "fontFamily"))
    ? { ...patch, fontWeight: undefined }
    : patch;
}
