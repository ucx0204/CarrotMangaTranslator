import type { PageEvidenceRow } from "./automaticFontMatchingV2PageConsistencyShared";

export type GlyphMorphologyBaseline = Readonly<{
  globalDistance: number;
  componentDistance: number;
  componentFill: number;
  foregroundLuma: number;
}>;

type GlyphMorphology = NonNullable<
  PageEvidenceRow["inference"]["glyphMorphology"]
>;

/** Project already-vetted glyph measurements without owning route policy. */
export function projectGlyphMorphologyBaseline(
  morphologies: readonly GlyphMorphology[],
): GlyphMorphologyBaseline {
  return {
    globalDistance: median(
      morphologies.map((entry) => entry.globalForegroundDistanceMean),
    ),
    componentDistance: median(
      morphologies.map((entry) => entry.medianComponentDistanceMean),
    ),
    componentFill: median(
      morphologies.map((entry) => entry.medianComponentFill),
    ),
    foregroundLuma: median(
      morphologies.map((entry) => entry.foregroundMeanLuma),
    ),
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
