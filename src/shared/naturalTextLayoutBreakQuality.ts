import type { NaturalBreakProfile } from "./naturalTextLayoutBreaks";
import type { NaturalWrapMode } from "./naturalTextLayoutMetrics";

export type NaturalBreakCounts = {
  emergency: number;
  secondary: number;
  discouraged: number;
};

const SECONDARY_BREAK_PENALTY = 160;
const DISCOURAGED_BREAK_PENALTY = 420;
const KOREAN_EMERGENCY_BREAK_PENALTY = 900;
const GRAPHEME_BREAK_PENALTY = 28;
const WORD_BREAK_PENALTY = 240;

export function resolveNaturalBoundaryPenalty(
  profile: NaturalBreakProfile,
  mode: NaturalWrapMode,
  boundary: number,
  graphemeCount: number,
): number {
  if (boundary >= graphemeCount) return 0;
  let penalty = 0;
  if (profile.secondary.has(boundary)) {
    penalty += SECONDARY_BREAK_PENALTY;
  } else if (!profile.preferred.has(boundary)) {
    penalty += profile.koreanBreakPriority
      ? KOREAN_EMERGENCY_BREAK_PENALTY
      : mode === "word"
        ? WORD_BREAK_PENALTY
        : GRAPHEME_BREAK_PENALTY;
  }
  if (profile.discouraged.has(boundary)) {
    penalty += DISCOURAGED_BREAK_PENALTY;
  }
  return penalty;
}

export function classifyNaturalBreak(
  profile: NaturalBreakProfile,
  boundary: number,
): NaturalBreakCounts {
  return {
    emergency: Number(
      !profile.preferred.has(boundary) && !profile.secondary.has(boundary),
    ),
    secondary: Number(profile.secondary.has(boundary)),
    discouraged: Number(profile.discouraged.has(boundary)),
  };
}

export function isCompletePreferredNaturalUnit(
  graphemeCount: number,
  start: number,
  end: number,
  preferred: ReadonlySet<number>,
): boolean {
  return (
    (start === 0 || preferred.has(start)) &&
    (end === graphemeCount || preferred.has(end))
  );
}
