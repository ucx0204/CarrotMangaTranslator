import { describe, expect, it } from "vitest";
import { rankFontMatchingV2Candidates } from "../src/main/pipeline/automaticFontMatchingV2Ranking";
import type { AutomaticFontCandidate } from "../src/shared/fontMatchingTypes";

describe("automatic font matching v2 semantic fallback ranking", () => {
  it("keeps retired Gugi in the contract-shaped ranking but marks it unrenderable", () => {
    const ranked = rankFontMatchingV2Candidates({
      candidates: [candidate("gugi", 0), candidate("jua", 1)],
      locale: "ko",
      profile: null,
      role: {
        primary: "sfx_motion",
        confidence: 0.94,
        alternatives: [],
      },
    });

    expect(ranked.find((entry) => entry.fontId === "gugi")).toMatchObject({
      renderStatus: "unrenderable",
      unrenderableReason: "font_retired_by_product_policy",
      confidence: 0,
      reasonCodes: expect.arrayContaining(["font_retired_by_product_policy"]),
    });
    expect(ranked.find((entry) => entry.fontId === "jua")).toMatchObject({
      renderStatus: "rendered",
      unrenderableReason: null,
    });
  });
});

function candidate(
  fontId: string,
  preferenceRank: number,
): AutomaticFontCandidate {
  return {
    source: "built-in",
    fontId,
    label: fontId,
    supportedLocales: ["ko"],
    unicodeRanges: [[0xac00, 0xd7a3]],
    weight: 400,
    width: 5,
    italic: false,
    serif: false,
    favorite: false,
    defaultFont: false,
    preferenceRank,
  };
}
