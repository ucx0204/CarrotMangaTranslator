import { describe, expect, it } from "vitest";
import type { TextStyleRun } from "../src/shared/richTextMarkup";
import type { TextWordBreak } from "../src/shared/textWrapping";
import {
  measureStyledWrappedTextInSlots,
  measureUniformStyledWrappedTextInSlots,
} from "../src/renderer/src/lib/bubbleTextWrapping";
import {
  measureStyledWrappedText,
  type TextMeasurementContext,
} from "../src/renderer/src/lib/overlayTextWrapping";

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

  it("uses each bubble slot width while preserving emergency word breaks", () => {
    const slots = [
      {
        blockOffsetPx: 0,
        inlineOffsetPx: 10,
        availableWidth: 30,
        regionIndex: 0,
      },
      {
        blockOffsetPx: 12,
        inlineOffsetPx: 0,
        availableWidth: 50,
        regionIndex: 0,
      },
      {
        blockOffsetPx: 24,
        inlineOffsetPx: 15,
        availableWidth: 20,
        regionIndex: 0,
      },
    ];
    const measured = measureStyledWrappedTextInSlots(
      fixedMeasureContext,
      plainRuns("ab cdefgh"),
      slots,
      12,
      10,
      "sans-serif",
      0,
      "break-word",
    );

    expect(lineTexts(measured.lines)).toEqual(["ab ", "cdefg", "h"]);
    expect(measured.lines.map((line) => line.slot)).toEqual(slots);
    expect(measured.consumedAll).toBe(true);
    expect(measured.fits).toBe(true);
  });

  it("reports an unbreakable word wider than its bubble slot", () => {
    const measured = measureStyledWrappedTextInSlots(
      fixedMeasureContext,
      plainRuns("abcdefgh"),
      [
        {
          blockOffsetPx: 0,
          inlineOffsetPx: 0,
          availableWidth: 50,
          regionIndex: 0,
        },
      ],
      12,
      10,
      "sans-serif",
      0,
      "normal",
    );

    expect(lineTexts(measured.lines)).toEqual(["abcdefgh"]);
    expect(measured.consumedAll).toBe(true);
    expect(measured.fits).toBe(false);
  });

  it("wraps styled vertical columns with a uniform top-to-bottom advance", () => {
    const slots = [
      {
        blockOffsetPx: 60,
        inlineOffsetPx: 5,
        availableWidth: 30,
        regionIndex: 0,
      },
      {
        blockOffsetPx: 40,
        inlineOffsetPx: 10,
        availableWidth: 20,
        regionIndex: 1,
      },
    ];
    const measured = measureUniformStyledWrappedTextInSlots(
      [
        { text: "가나", bold: true, italic: false },
        { text: "다라", bold: false, italic: true },
      ],
      slots,
      20,
      10,
      "break-all",
    );

    expect(lineTexts(measured.lines)).toEqual(["가나다", "라"]);
    expect(measured.lines[0]?.runs).toEqual([
      { text: "가나", bold: true, italic: false },
      { text: "다", bold: false, italic: true },
    ]);
    expect(measured.lines.map((line) => line.slot)).toEqual(slots);
    expect(measured.consumedAll).toBe(true);
    expect(measured.fits).toBe(true);
  });
});

const fixedMeasureContext = {
  font: "",
  measureText: () => ({ width: 10 }) as TextMetrics,
} satisfies TextMeasurementContext;

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
