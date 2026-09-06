import { describe, expect, it } from "vitest";
import { resolveFontTextureSelection } from "../src/main/pipeline/automaticFontMatchingTexture";
import {
  FONT_TEXTURE_CONTRACT,
  FONT_TEXTURE_MODEL_SHA256,
  type FontTextureInference,
} from "../src/main/pipeline/fontMatchingTextureTypes";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
const candidates = ["shilla-culture", "nanum-myeongjo"].map((fontId) =>
  makeAutomaticFontCandidate({ fontId }),
);
const strong: FontTextureInference = {
  contractVersion: FONT_TEXTURE_CONTRACT,
  modelSha256: FONT_TEXTURE_MODEL_SHA256,
  patchCount: 8,
  probabilities: Array.from({ length: 11 }, (_, i) => (i === 9 ? 0.95 : 0.005)),
  weightProbabilities: [0.01, 0.01, 0.01, 0.97],
};
describe("selective Shilla middle emphasis", () => {
  it("selects the actual medium face only within the user's pool", () => {
    expect(resolveFontTextureSelection(strong, candidates)).toEqual({
      fontId: "shilla-culture",
      fontWeight: 500,
      italic: false,
    });
    expect(resolveFontTextureSelection(strong, candidates.slice(1))).toBeNull();
  });
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 10])(
    "never maps unvalidated texture class %i",
    (type) => {
      expect(
        resolveFontTextureSelection(
          {
            ...strong,
            probabilities: Array.from({ length: 11 }, (_, i) =>
              i === type ? 0.95 : 0.005,
            ),
          },
          candidates,
        ),
      ).toBeNull();
    },
  );
  it.each([
    { modelSha256: "f".repeat(64) },
    { patchCount: 1 },
    { patchCount: 9 },
    { patchCount: 2.5 },
    { probabilities: [1] },
    { probabilities: [...strong.probabilities.slice(0, 10), NaN] },
    {
      probabilities: Array.from({ length: 11 }, (_, i) =>
        i === 9 ? 0.799 : 0.0201,
      ),
    },
    { weightProbabilities: [0.01, 0.01, 0.97, 0.01] },
    { weightProbabilities: [0, 0, 0, 1.01] },
  ])("keeps current choice on uncertain or invalid evidence %j", (override) => {
    expect(
      resolveFontTextureSelection({ ...strong, ...override }, candidates),
    ).toBeNull();
  });
});
