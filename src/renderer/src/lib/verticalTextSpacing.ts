import { segmentNaturalTextGraphemes } from "../../../shared/naturalTextLayoutSegmentation";

const VERTICAL_ASCII_SPACE_EM = 0.5;
const VERTICAL_IDEOGRAPHIC_SPACE_EM = 1;
const VERTICAL_DASH_SYMBOLS = new Set(["—", "―"]);
const VERTICAL_WAVE_SYMBOLS = new Set(["〜", "～", "∼"]);
const VERTICAL_UPRIGHT_SYMBOLS = new Set(["♡", "♥", "♪", "♬"]);
const VERTICAL_ELLIPSIS_PRESENTATION = "︙";
const VERTICAL_WAVE_PRESENTATION = "︴";

/**
 * U+FE34 (︴) outline from the bundled Huninn font. The renderer normalizes
 * and centers it in one em square so the selected text font cannot shift it.
 */
export const VERTICAL_WAVE_GLYPH_PATH = [
  "M62 -120Q62 -83 77 -60Q92 -37 111.5 -24Q131 -11 146 -4",
  "L153 -1L159 2Q177 10 186.5 18Q196 26 196 48",
  "Q196 74 181.5 82.5Q167 91 147 99Q132 106 112 118.5",
  "Q92 131 77 154Q62 177 62 213Q62 251 77 273",
  "Q92 295 112 307.5Q132 320 146 327Q167 337 181.5 345.5",
  "Q196 354 196 379Q196 400 185 409.5Q174 419 158 426",
  "L146 432Q132 440 112 452Q92 464 77 486Q62 508 62 546",
  "Q62 584 77 605.5Q92 627 112.5 639Q133 651 147 658",
  "Q169 669 183 677.5Q197 686 197 711Q197 737 183 746",
  "Q169 755 149 762Q62 798 62 880H130Q130 850 144 840.5",
  "Q158 831 179 821Q195 814 215 802.5Q235 791 250 769.5",
  "Q265 748 265 711Q265 673 249.5 652Q234 631 214 620.5",
  "Q194 610 178 602Q159 594 144 584Q129 574 129 546",
  "Q129 518 144 508Q159 498 178 490Q194 483 214 471.5",
  "Q234 460 249 438.5Q264 417 264 379Q264 342 248.5 321.5",
  "Q233 301 213 290Q193 279 178 270Q159 260 144 250.5",
  "Q129 241 129 213Q129 186 144 175.5Q159 165 179 156",
  "Q194 150 214 139Q234 128 249 107Q264 86 264 48",
  "Q264 11 249 -10.5Q234 -32 213.5 -43.5Q193 -55 177 -63",
  "Q156 -72 143 -81Q130 -90 130 -120Z",
].join("");

export const VERTICAL_WAVE_GLYPH_TRANSFORM =
  "translate(33.65 88) scale(0.1 -0.1)";

export type VerticalTextSpacingToken = {
  /** Original text. This remains the value saved and copied by the editor. */
  text: string;
  /** Visual-only substitution used while rendering vertical text. */
  displayText?: string;
  advanceEm?: number;
  presentation?: "dash" | "ellipsis" | "wave";
  kind?: "ascii" | "ideographic" | "dash" | "ellipsis" | "rotate" | "upright";
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

  const graphemes = segmentNaturalTextGraphemes(text);
  for (let index = 0; index < graphemes.length; index += 1) {
    const character = graphemes[index];
    if (VERTICAL_DASH_SYMBOLS.has(character)) {
      flushPlain();
      const dashRun = readVerticalDashRun(graphemes, index);
      tokens.push({
        text: dashRun.text,
        kind: "dash",
        presentation: "dash",
      });
      index = dashRun.endIndex;
      continue;
    }
    const presentation = createVerticalPresentationToken(character);
    if (!presentation) {
      plain += character;
      continue;
    }
    flushPlain();
    tokens.push(presentation);
  }
  flushPlain();
  return tokens;
}

function readVerticalDashRun(
  graphemes: string[],
  startIndex: number,
): { endIndex: number; text: string } {
  let endIndex = startIndex;
  while (VERTICAL_DASH_SYMBOLS.has(graphemes[endIndex + 1] ?? "")) {
    endIndex += 1;
  }
  return { endIndex, text: graphemes.slice(startIndex, endIndex + 1).join("") };
}

function createVerticalPresentationToken(
  character: string,
): VerticalTextSpacingToken | null {
  if (character === " ") {
    return {
      text: character,
      advanceEm: VERTICAL_ASCII_SPACE_EM,
      kind: "ascii",
    };
  }
  if (character === "\u3000") {
    return {
      text: character,
      advanceEm: VERTICAL_IDEOGRAPHIC_SPACE_EM,
      kind: "ideographic",
    };
  }
  if (character === "…" || character === "⋯") {
    return createSymbolToken(
      character,
      VERTICAL_ELLIPSIS_PRESENTATION,
      "ellipsis",
      "ellipsis",
    );
  }
  if (VERTICAL_WAVE_SYMBOLS.has(character)) {
    return createSymbolToken(
      character,
      VERTICAL_WAVE_PRESENTATION,
      "rotate",
      "wave",
    );
  }
  if (VERTICAL_UPRIGHT_SYMBOLS.has(character)) {
    return createSymbolToken(character, character, "upright");
  }
  return null;
}

function createSymbolToken(
  text: string,
  displayText: string,
  kind: "ellipsis" | "rotate" | "upright",
  presentation?: VerticalTextSpacingToken["presentation"],
): VerticalTextSpacingToken {
  return {
    text,
    displayText,
    advanceEm: 1,
    kind,
    ...(presentation ? { presentation } : {}),
  };
}

/**
 * Segments one vertical style run into layout units.
 */
export function segmentVerticalTextGraphemes(text: string): string[] {
  return tokenizeVerticalTextSpacing(text).flatMap((token) =>
    token.kind === undefined || token.kind === "dash"
      ? segmentNaturalTextGraphemes(token.text)
      : [token.text],
  );
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
