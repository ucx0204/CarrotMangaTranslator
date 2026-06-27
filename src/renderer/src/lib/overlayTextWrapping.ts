import type { TextStyleRun } from "../../../shared/richTextMarkup";

export type BlockTextLine = {
  runs: TextStyleRun[];
  width: number;
};

export type WrappedTextMeasurement = {
  lines: BlockTextLine[];
  lineCount: number;
  totalHeight: number;
  maxLineWidth: number;
};

export function measureStyledWrappedText(
  context: CanvasRenderingContext2D,
  runs: TextStyleRun[],
  maxWidth: number,
  lineHeightPx: number,
  fontSize: number,
  fontFamily: string,
  letterSpacingPx: number,
): WrappedTextMeasurement {
  const lines: BlockTextLine[] = [];
  let lineRuns: TextStyleRun[] = [];
  let lineCount = 0;
  let lineWidth = 0;
  let maxLineWidth = 0;
  let lineHasContent = false;

  const breakLine = (): void => {
    lines.push({
      runs: lineRuns,
      width: lineWidth,
    });
    maxLineWidth = Math.max(maxLineWidth, lineWidth);
    lineCount += 1;
    lineRuns = [];
    lineWidth = 0;
    lineHasContent = false;
  };

  const appendChar = (char: string, bold: boolean, italic: boolean): void => {
    const lastRun = lineRuns.at(-1);
    if (lastRun && lastRun.bold === bold && lastRun.italic === italic) {
      lastRun.text += char;
      return;
    }
    lineRuns.push({ text: char, bold, italic });
  };

  for (const run of runs) {
    context.font = buildFontForStyle(
      fontSize,
      fontFamily,
      run.bold,
      run.italic,
    );
    for (const char of [...run.text]) {
      if (char === "\n") {
        breakLine();
        continue;
      }
      const charWidth = context.measureText(char).width;
      const advance = charWidth + (lineHasContent ? letterSpacingPx : 0);
      if (lineHasContent && lineWidth + advance > maxWidth) {
        breakLine();
        appendChar(char, run.bold, run.italic);
        lineWidth = charWidth;
      } else {
        appendChar(char, run.bold, run.italic);
        lineWidth += advance;
      }
      lineHasContent = true;
    }
  }
  breakLine();

  return {
    lines,
    lineCount,
    totalHeight: lineCount * lineHeightPx,
    maxLineWidth,
  };
}

function buildFontForStyle(
  fontSize: number,
  fontFamily: string,
  bold: boolean,
  italic: boolean,
): string {
  const style = italic ? "italic " : "";
  const weight = bold ? 800 : 400;
  return `${style}${weight} ${fontSize}px ${fontFamily}`;
}
