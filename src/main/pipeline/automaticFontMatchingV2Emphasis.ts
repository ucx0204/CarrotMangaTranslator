import type {
  FontMatchingSourceStyleV2,
  FontMatchingTreatmentV2,
  FontStyleSelectionV2,
} from "../../shared/fontMatchingProfileTypes";

const MINIMUM_BASELINE_SAMPLES = 2;
const MINIMUM_RELATIVE_BASELINE_SAMPLES = 3;
const RELATIVE_BOLD_DELTA = 0.08;
const RELATIVE_EXTRA_BOLD_DELTA = 0.16;
const ABSOLUTE_BOLD_WEIGHT = 0.78;
const ABSOLUTE_EXTRA_BOLD_WEIGHT = 0.9;

type AutomaticFontEmphasisStyle = Readonly<
  Partial<Pick<FontStyleSelectionV2, "fontWeight">>
>;

export interface AutomaticFontEmphasisInput {
  sourceStyle: FontMatchingSourceStyleV2;
  treatment: Pick<FontMatchingTreatmentV2, "outline">;
  pageBaselineWeight?: number | null;
  pageBaselineSampleCount?: number;
}

export interface AutomaticFontEmphasisResolution {
  style: AutomaticFontEmphasisStyle;
  weightSignal: number | null;
  pageBaselineWeight: number | null;
  emphasisThreshold: number;
  extraBoldThreshold: number;
  reasonCodes: readonly string[];
}

/**
 * Builds a page-relative weight baseline from caller-selected ordinary balloon
 * text. The caller intentionally owns membership so semantic-role predictions
 * cannot silently influence this visual policy.
 */
export function resolveAutomaticFontPageWeightBaseline(
  ordinarySourceStyles: readonly FontMatchingSourceStyleV2[],
): number | null {
  const weights = ordinarySourceStyles
    .map(resolveSourceWeight)
    .filter((weight): weight is number => weight !== null)
    .sort((left, right) => left - right);
  if (weights.length < MINIMUM_BASELINE_SAMPLES) return null;
  // The lower 60% estimates the base face even when a page contains several
  // intentionally bold lines from that same family.
  const baseWeights = weights.slice(
    0,
    Math.max(MINIMUM_BASELINE_SAMPLES, Math.ceil(weights.length * 0.6)),
  );
  return median(baseWeights);
}

/**
 * Converts pixel-derived weight and outline evidence into style overrides only.
 * It never chooses or changes a font family, and intentionally ignores energy.
 */
export function resolveAutomaticFontEmphasisStyle(
  input: AutomaticFontEmphasisInput,
): AutomaticFontEmphasisResolution {
  const weightSignal = resolveSourceWeight(input.sourceStyle);
  const pageBaselineWeight = normalizeSignal(input.pageBaselineWeight);
  const usesRelativeBaseline =
    pageBaselineWeight !== null &&
    (input.pageBaselineSampleCount ?? 0) >= MINIMUM_RELATIVE_BASELINE_SAMPLES;
  const emphasisThreshold = usesRelativeBaseline
    ? pageBaselineWeight + RELATIVE_BOLD_DELTA
    : ABSOLUTE_BOLD_WEIGHT;
  const extraBoldThreshold = usesRelativeBaseline
    ? pageBaselineWeight + RELATIVE_EXTRA_BOLD_DELTA
    : ABSOLUTE_EXTRA_BOLD_WEIGHT;
  const style: Partial<Pick<FontStyleSelectionV2, "fontWeight">> = {};
  const reasonCodes: string[] = [];

  if (weightSignal !== null) {
    if (weightSignal >= extraBoldThreshold) {
      style.fontWeight = 800;
      reasonCodes.push("source_weight_extra_bold");
    } else if (weightSignal >= emphasisThreshold) {
      style.fontWeight = 700;
      reasonCodes.push(
        usesRelativeBaseline
          ? "page_relative_weight_emphasis"
          : "absolute_weight_emphasis",
      );
    } else {
      style.fontWeight = 400;
      reasonCodes.push("source_weight_normal");
    }
  }

  return {
    style,
    weightSignal,
    pageBaselineWeight,
    emphasisThreshold,
    extraBoldThreshold,
    reasonCodes,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2
    : (values[middle] ?? null);
}

function resolveSourceWeight(
  sourceStyle: FontMatchingSourceStyleV2,
): number | null {
  if (sourceStyle.unknownFields.includes("weight")) return null;
  return normalizeSignal(sourceStyle.weight);
}

function normalizeSignal(value: number | null | undefined): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}
