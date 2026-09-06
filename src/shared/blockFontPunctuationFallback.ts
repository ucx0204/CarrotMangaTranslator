/** Explicit renderer composition, not a claim about the primary font's cmap. */
export function resolveBlockFontPunctuationFallback(
  fontId: string | undefined,
) {
  return fontId === "shilla-culture"
    ? {
        fontId: "nanum-myeongjo",
        cssFamily: '"MGT Nanum Myeongjo"',
        characters: "「」『』",
      }
    : null;
}
