export type NaturalBreakCandidate = {
  fontSizePx: number;
  wrapped: {
    emergencyBreakCount: number;
    secondaryBreakCount: number;
    discouragedBreakCount: number;
  };
};

export type NaturalBreakCandidateSelectionOptions<
  Candidate extends NaturalBreakCandidate,
> = {
  autoFitText: boolean;
  baselineFontSizePx: number;
  minimumReadableFontSizePx: number;
  minimumSemanticFontRatio: number;
  minimumIdealFontRatio: number;
  semanticWordPriority: boolean;
  resolveAtFont: (
    fontSizePx: number,
    allowSinglePreferredUnit: boolean,
  ) => Candidate | null;
};

/**
 * Keeps the maximum-font result unless a bounded, still-readable reduction
 * removes a Korean phrase or eojeol split. The integer scan is deliberate:
 * shape-derived line plans can appear or disappear at adjacent font sizes.
 */
export function selectNaturalBreakCandidate<
  Candidate extends NaturalBreakCandidate,
>(options: NaturalBreakCandidateSelectionOptions<Candidate>): Candidate | null {
  const baselineCandidate = options.resolveAtFont(
    options.baselineFontSizePx,
    options.semanticWordPriority,
  );
  if (!options.semanticWordPriority) return baselineCandidate;
  if (baselineCandidate && hasIdealNaturalBreaks(baselineCandidate)) {
    return baselineCandidate;
  }
  if (!options.autoFitText) {
    return baselineCandidate && hasCleanNaturalBreaks(baselineCandidate)
      ? baselineCandidate
      : null;
  }
  return findSmallerNaturalBreakCandidate(options, baselineCandidate);
}

function findSmallerNaturalBreakCandidate<
  Candidate extends NaturalBreakCandidate,
>(
  options: NaturalBreakCandidateSelectionOptions<Candidate>,
  baselineCandidate: Candidate | null,
): Candidate | null {
  const minimumFontSizePx = Math.max(
    options.minimumReadableFontSizePx,
    Math.ceil(options.baselineFontSizePx * options.minimumSemanticFontRatio),
  );
  const minimumIdealFontSizePx = Math.max(
    minimumFontSizePx,
    Math.ceil(options.baselineFontSizePx * options.minimumIdealFontRatio),
  );
  let bestCleanCandidate =
    baselineCandidate && hasCleanNaturalBreaks(baselineCandidate)
      ? baselineCandidate
      : null;
  for (
    let fontSizePx = options.baselineFontSizePx - 1;
    fontSizePx >= minimumFontSizePx;
    fontSizePx -= 1
  ) {
    const candidate = options.resolveAtFont(fontSizePx, true);
    if (!candidate || !hasCleanNaturalBreaks(candidate)) continue;
    bestCleanCandidate ??= candidate;
    if (
      fontSizePx >= minimumIdealFontSizePx &&
      hasIdealNaturalBreaks(candidate)
    ) {
      return candidate;
    }
  }
  return bestCleanCandidate;
}

function hasCleanNaturalBreaks(candidate: NaturalBreakCandidate): boolean {
  return (
    candidate.wrapped.emergencyBreakCount === 0 &&
    candidate.wrapped.discouragedBreakCount === 0
  );
}

function hasIdealNaturalBreaks(candidate: NaturalBreakCandidate): boolean {
  return (
    hasCleanNaturalBreaks(candidate) &&
    candidate.wrapped.secondaryBreakCount === 0
  );
}
