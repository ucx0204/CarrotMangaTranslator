import { describe, expect, it } from "vitest";
import { assessAutomaticFontTranslations } from "../src/main/pipeline/automaticFontMatchingV2CandidateAssessment";
import { fontCandidateSupportsText } from "../src/main/fontCoverage";
import { makeAutomaticFontCandidate } from "./helpers/automaticFontCandidate";
const primary = makeAutomaticFontCandidate({
  fontId: "shilla-culture",
  source: "built-in",
  unicodeRanges: [
    [0x20, 0x7e],
    [0xac00, 0xd7a3],
  ],
});
const fallback = makeAutomaticFontCandidate({
  fontId: "nanum-myeongjo",
  source: "built-in",
  unicodeRanges: [[0x300c, 0x300f]],
});
describe("declared Shilla punctuation fallback", () => {
  it("preserves strict primary coverage while accepting the verified available fallback", () => {
    expect(fontCandidateSupportsText(primary, "『희망』")).toBe(false);
    expect(
      assessAutomaticFontTranslations([primary, fallback], "『희망』")[0],
    ).toMatchObject({
      glyphCoverage: 1,
      glyphsRenderable: true,
      missingGlyphCount: 0,
    });
  });
  it("rejects absent fallback, missing fallback glyphs, and unsupported content", () => {
    for (const candidates of [
      [primary],
      [primary, { ...fallback, unicodeRanges: [] }],
      [{ ...primary, source: "custom" as const }, fallback],
      [primary, { ...fallback, source: "custom" as const }],
    ])
      expect(
        assessAutomaticFontTranslations(candidates, "『희망』")[0]
          .glyphsRenderable,
      ).toBe(false);
    expect(
      assessAutomaticFontTranslations([primary, fallback], "希望")[0]
        .glyphsRenderable,
    ).toBe(false);
    expect(
      assessAutomaticFontTranslations(
        [{ ...primary, fontId: "other" }, fallback],
        "『희망』",
      )[0].glyphsRenderable,
    ).toBe(false);
  });
});
