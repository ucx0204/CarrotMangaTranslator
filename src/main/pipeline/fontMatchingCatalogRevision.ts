import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import { isDemotedBlockFontId } from "../../shared/demotedBlockFonts";

export const FONT_CATALOG_REVISION = "korean-palette-20260906-v1";
export const ADDED_MATCHING_FONT_IDS = [
  "kkubulim",
  "geummyeon-seongsil",
  "shilla-culture",
] as const;

/** R33's immutable classifier channels remain separate from the installed render palette. */
export function isRevisedFontCatalog(
  legacyIds: readonly string[],
  currentIds: readonly string[],
): boolean {
  const expected = [
    ...legacyIds.filter((id) => !isDemotedBlockFontId(id)),
    ...ADDED_MATCHING_FONT_IDS,
  ];
  return (
    currentIds.length === expected.length &&
    new Set(currentIds).size === currentIds.length &&
    expected.every((id) => currentIds.includes(id))
  );
}

export function retiredClassifierChannel(
  fontId: string,
): AutomaticFontCandidate {
  if (!isDemotedBlockFontId(fontId))
    throw new Error("Unknown retired classifier channel.");
  return {
    source: "built-in",
    fontId,
    label: fontId,
    // No installed font is claimed. Empty coverage makes these channels unrenderable.
    supportedLocales: [],
    unicodeRanges: [],
    weight: 400,
    width: 5,
    italic: false,
    favorite: false,
    defaultFont: false,
    preferenceRank: 1000,
  };
}
