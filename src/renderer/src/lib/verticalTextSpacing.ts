const VERTICAL_ASCII_SPACE_EM = 0.5;
const VERTICAL_IDEOGRAPHIC_SPACE_EM = 1;

export type VerticalTextSpacingToken = {
  text: string;
  advanceEm?: number;
  kind?: "ascii" | "ideographic";
};

export function tokenizeVerticalTextSpacing(
  text: string,
): VerticalTextSpacingToken[] {
  const tokens: VerticalTextSpacingToken[] = [];
  let plain = "";
  const flushPlain = (): void => {
    if (!plain) return;
    tokens.push({ text: plain });
    plain = "";
  };

  for (const character of Array.from(text)) {
    if (character === " ") {
      flushPlain();
      tokens.push({
        text: character,
        advanceEm: VERTICAL_ASCII_SPACE_EM,
        kind: "ascii",
      });
    } else if (character === "\u3000") {
      flushPlain();
      tokens.push({
        text: character,
        advanceEm: VERTICAL_IDEOGRAPHIC_SPACE_EM,
        kind: "ideographic",
      });
    } else {
      plain += character;
    }
  }
  flushPlain();
  return tokens;
}

export function resolveDefaultVerticalGraphemeAdvancePx(
  fontSizePx: number,
  lineHeightPx: number,
  letterSpacingPx: number,
): number {
  return Math.max(1, Math.max(fontSizePx, lineHeightPx) + letterSpacingPx);
}

export function resolveVerticalGraphemeAdvancePx(
  grapheme: string,
  fontSizePx: number,
  defaultAdvancePx: number,
  letterSpacingPx: number,
): number {
  if (grapheme === " ") {
    return Math.max(1, fontSizePx * VERTICAL_ASCII_SPACE_EM + letterSpacingPx);
  }
  if (grapheme === "\u3000") {
    return Math.max(
      1,
      fontSizePx * VERTICAL_IDEOGRAPHIC_SPACE_EM + letterSpacingPx,
    );
  }
  return defaultAdvancePx;
}
