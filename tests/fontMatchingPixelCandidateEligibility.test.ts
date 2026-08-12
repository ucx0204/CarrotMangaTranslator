import { describe, expect, it } from "vitest";
import type {
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
} from "../src/shared/fontMatchingProfileTypes";
import { maskIneligiblePixelCandidateScores } from "../src/main/pipeline/fontMatchingPixelCandidateEligibility";

const CANDIDATE_IDS = ["dohyeon", "single-day", "jua"] as const;

describe("pixel-role specialist font eligibility", () => {
  it.each(["dialogue", "narration", "thought"] as const)(
    "masks Single Day for %s without mutating the original logits",
    (role) => {
      const original = Float32Array.from([0, 8, 1]);

      const masked = maskIneligiblePixelCandidateScores(
        CANDIDATE_IDS,
        original,
        prediction(role, 0.99),
      );

      expect([...original]).toEqual([0, 8, 1]);
      expect(masked[1]).toBeLessThan(Math.min(masked[0], masked[2]));
    },
  );

  it.each([
    "whisper",
    "aside_balloon_edge",
    "sfx_impact",
    "sfx_motion",
    "sfx_ambient",
    "sfx_emotion",
    "sfx_comic",
  ] as const)("keeps Single Day in normal competition for %s", (role) => {
    const original = Float32Array.from([0, 8, 1]);

    expect(
      maskIneligiblePixelCandidateScores(
        CANDIDATE_IDS,
        original,
        prediction(role, 0.01),
      ),
    ).toEqual(original);
  });

  it.each([
    "emphasis_dialogue",
    "shout",
    "sign_ui_title",
    "other",
    "unknown_needs_review",
  ] as const)(
    "requires both strong raw margin and pixel-role confidence for %s",
    (role) => {
      const strong = Float32Array.from([0, 2, 1]);
      const weakMargin = Float32Array.from([0, 1.5, 1]);

      expect(
        maskIneligiblePixelCandidateScores(
          CANDIDATE_IDS,
          strong,
          prediction(role, 0.9),
        ),
      ).toEqual(strong);
      expect(
        maskIneligiblePixelCandidateScores(
          CANDIDATE_IDS,
          weakMargin,
          prediction(role, 0.9),
        )[1],
      ).toBeLessThan(0);
      expect(
        maskIneligiblePixelCandidateScores(
          CANDIDATE_IDS,
          strong,
          prediction(role, 0.74),
        )[1],
      ).toBeLessThan(0);
    },
  );

  it("fails closed when candidate ids and logits drift", () => {
    expect(() =>
      maskIneligiblePixelCandidateScores(
        CANDIDATE_IDS,
        Float32Array.from([1, 2]),
        prediction("dialogue", 1),
      ),
    ).toThrow("candidate eligibility boundary drifted");
  });
});

function prediction(
  primary: FontMatchingSemanticRole,
  confidence: number,
): FontMatchRolePredictionV2 {
  return { primary, confidence, alternatives: [] };
}
