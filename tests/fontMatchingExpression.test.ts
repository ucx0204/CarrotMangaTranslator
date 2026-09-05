import { describe, expect, it } from "vitest";
import { resolveFontExpressionSelection } from "../src/main/pipeline/automaticFontMatchingExpression";
import {
  FONT_EXPRESSION_CONTRACT,
  FONT_EXPRESSION_MODEL_SHA256,
  type FontExpressionInference,
} from "../src/main/pipeline/fontMatchingExpressionTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";

const candidates = ["griun-pol-sensibility", "dohyeon", "start-over"].map(
  (fontId) => makeAutomaticFontCandidate({ fontId }),
);
const heavy: FontExpressionInference = {
  contractVersion: FONT_EXPRESSION_CONTRACT,
  modelSha256: FONT_EXPRESSION_MODEL_SHA256,
  componentCount: 3,
  probabilities: [0.01, 0.01, 0.01, 0.95, 0.01, 0.01],
};

describe("source ink heavy rescue", () => {
  it("uses a real heavy face without synthetic bold and respects the available pool", () => {
    expect(resolveFontExpressionSelection(heavy, candidates)).toEqual({
      fontId: "dohyeon",
      fontWeight: 400,
      italic: false,
    });
    expect(
      resolveFontExpressionSelection(heavy, candidates.slice(0, 1)),
    ).toBeNull();
  });

  it.each([0, 1, 2, 4, 5])(
    "preserves baseline for unvalidated expression class %i",
    (type) => {
      const probabilities = Array.from({ length: 6 }, (_, i) =>
        i === type ? 0.95 : 0.01,
      );
      expect(
        resolveFontExpressionSelection({ ...heavy, probabilities }, candidates),
      ).toBeNull();
    },
  );

  it.each([
    { modelSha256: "a".repeat(64) },
    { componentCount: 1 },
    { componentCount: 17 },
    { componentCount: 2.5 },
    { probabilities: [0.1, 0.1, 0.1, 0.5, 0.1, 0.1] },
    { probabilities: [0, 0, 0, Number.NaN, 0, 0] },
    { probabilities: [0, 0, 0, 1.1, -0.1, 0] },
    { probabilities: [0, 0, 0, 0.9, 0, 0] },
    { probabilities: [] },
  ])("does not mutate on invalid or uncertain evidence %j", (override) => {
    expect(
      resolveFontExpressionSelection({ ...heavy, ...override }, candidates),
    ).toBeNull();
  });
});
