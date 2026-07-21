import { describe, expect, it } from "vitest";
import type { TextStyleRun } from "../src/shared/richTextMarkup";
import type { TextWordBreak } from "../src/shared/textWrapping";
import { measureStyledWrappedText } from "../src/renderer/src/lib/overlayTextWrapping";

describe("overlay text word breaking", () => {
  it("distinguishes natural, anywhere, keep-together, and emergency wrapping", () => {
    const expected: Record<TextWordBreak, string[]> = {
      normal: ["ab ", "cdefgh"],
      "break-all": ["ab cd", "efgh"],
      "keep-all": ["ab ", "cdefgh"],
      "break-word": ["ab ", "cdefg", "h"],
    };

    for (const wordBreak of Object.keys(expected) as TextWordBreak[]) {
      expect(measureLines(plainRuns("ab cdefgh"), 50, wordBreak)).toEqual(
        expected[wordBreak],
      );
    }
  });

  it("allows ordinary CJK breaks except in the keep-together mode", () => {
    expect(measureLines(plainRuns("가나다라마"), 30, "normal")).toEqual([
      "가나다",
      "라마",
    ]);
    expect(measureLines(plainRuns("가나다라마"), 30, "break-word")).toEqual([
      "가나다",
      "라마",
    ]);
    expect(measureLines(plainRuns("가나다라마"), 30, "keep-all")).toEqual([
      "가나다라마",
    ]);
    expect(measureLines(plainRuns("가,나"), 20, "normal")).toEqual([
      "가,",
      "나",
    ]);
  });

  it("uses language-aware word opportunities for text without spaces", () => {
    expect(measureLines(plainRuns("ภาษาไทย"), 40, "normal")).toEqual([
      "ภาษา",
      "ไทย",
    ]);
    expect(measureLines(plainRuns("ภาษาไทย"), 40, "keep-all")).toEqual([
      "ภาษา",
      "ไทย",
    ]);
  });

  it("preserves explicit lines and rich styles without treating run boundaries as breaks", () => {
    const measured = measureStyledWrappedText(
      fixedMeasureContext,
      [
        { text: "ab", bold: true, italic: false },
        { text: "cd\nef", bold: false, italic: true },
      ],
      25,
      12,
      10,
      "sans-serif",
      0,
      "normal",
    );

    expect(lineTexts(measured.lines)).toEqual(["abcd", "ef"]);
    expect(measured.lines[0].runs).toEqual([
      { text: "ab", bold: true, italic: false },
      { text: "cd", bold: false, italic: true },
    ]);
    expect(measured.lineCount).toBe(2);
  });

  it("never splits a grapheme cluster in the anywhere mode", () => {
    expect(measureLines(plainRuns("A👨‍👩‍👧‍👦B"), 10, "break-all")).toEqual([
      "A",
      "👨‍👩‍👧‍👦",
      "B",
    ]);
    expect(
      measureLines(
        [
          { text: "e", bold: false, italic: false },
          { text: "\u0301", bold: true, italic: false },
          { text: "B", bold: false, italic: false },
        ],
        10,
        "break-all",
      ),
    ).toEqual(["é", "B"]);
  });
});

const fixedMeasureContext = {
  font: "",
  measureText: () => ({ width: 10 }) as TextMetrics,
} as unknown as CanvasRenderingContext2D;

function plainRuns(text: string): TextStyleRun[] {
  return [{ text, bold: false, italic: false }];
}

function measureLines(
  runs: TextStyleRun[],
  maxWidth: number,
  wordBreak: TextWordBreak,
): string[] {
  return lineTexts(
    measureStyledWrappedText(
      fixedMeasureContext,
      runs,
      maxWidth,
      12,
      10,
      "sans-serif",
      0,
      wordBreak,
    ).lines,
  );
}

function lineTexts(lines: Array<{ runs: TextStyleRun[] }>): string[] {
  return lines.map((line) => line.runs.map((run) => run.text).join(""));
}
