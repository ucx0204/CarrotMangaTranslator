import type { AutomaticFontCandidate } from "../../src/shared/fontMatchingTypes";

export function makeAutomaticFontCandidate(
  overrides: Partial<AutomaticFontCandidate> = {},
): AutomaticFontCandidate {
  return {
    source: "custom",
    fontId: "7432f752-8615-4708-a3d6-57bbcb05bdda",
    label: "Readable User Font",
    supportedLocales: ["ko"],
    unicodeRanges: [[0, 0x10ffff]],
    weight: 400,
    width: 5,
    italic: false,
    favorite: false,
    defaultFont: true,
    preferenceRank: 0,
    ...overrides,
  };
}
