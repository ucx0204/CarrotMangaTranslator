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
import {
  resolveNaturalWordBreakOffsets,
  segmentGraphemes,
} from "../src/renderer/src/lib/overlayTextSegmentation";

describe("overlay text word breaking", () => {
  it("uses visible soft-line width without changing the manual whitespace contract", () => {
    const measure = (trimLineEnds: boolean) =>
      measureStyledWrappedText(
        fixedMeasureContext,
        plainRuns("상관없어! 정말"),
        50,
        12,
        10,
        "sans-serif",
        0,
        "keep-all-overflow",
        undefined,
        trimLineEnds,
      );
    const automatic = measure(true);
    expect(lineTexts(automatic.lines)).toEqual(["상관없어!", "정말"]);
    expect(automatic.lines[0].width).toBe(50);
    expect(automatic.lines[0].sourceTextLength).toBe(6);
    expect(lineTexts(measure(false).lines)).toEqual(["상관없어!", " 정말"]);
  });
  it("distinguishes natural, anywhere, keep-together, and emergency wrapping", () => {
    const expected: Record<TextWordBreak, string[]> = {
      normal: ["ab ", "cdefgh"],
      "break-word": ["ab ", "cdefg", "h"],
      "break-all": ["ab cd", "efgh"],
      "keep-all": ["ab ", "cdefgh"],
      "keep-all-overflow": ["ab ", "cdefg", "h"],
    };

    for (const wordBreak of Object.keys(expected) as TextWordBreak[]) {
      expect(measureLines(plainRuns("ab cdefgh"), 50, wordBreak)).toEqual(
        expected[wordBreak],
      );
    }
  });

  it("keeps legacy word wrapping while offering a separate overflow-safe mode", () => {
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
    expect(
      measureLines(plainRuns("가나다라마"), 30, "keep-all-overflow"),
    ).toEqual(["가나다", "라마"]);
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

  it("keeps an empty paragraph as one measurable empty line", () => {
    expect(measureLines(plainRuns(""), 50, "normal")).toEqual([""]);
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

  it("keeps the conservative grapheme fallback identical without Intl.Segmenter", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(segmentGraphemes("Ae\u0301👨‍👩‍👧‍👦🇰🇷B")).toEqual([
        "A",
        "e\u0301",
        "👨‍👩‍👧‍👦",
        "🇰🇷",
        "B",
      ]);
      expect(
        resolveNaturalWordBreakOffsets(
          segmentGraphemes("가나다 라마").map((text) => ({ text })),
        ),
      ).toEqual(new Set());
    } finally {
      restoreIntlSegmenter(descriptor);
    }
  });

  it("reuses the shared segmenter until the platform constructor changes", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    let constructions = 0;
    class CountingSegmenter {
      constructor(_locale?: string, _options?: Intl.SegmenterOptions) {
        constructions += 1;
      }

      segment(value: string): Array<{ segment: string; index: number }> {
        return Array.from(value, (segment, index) => ({ segment, index }));
      }
    }
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: CountingSegmenter,
    });
    try {
      expect(segmentGraphemes("AB")).toEqual(["A", "B"]);
      expect(segmentGraphemes("CD")).toEqual(["C", "D"]);
      expect(constructions).toBe(1);
    } finally {
      restoreIntlSegmenter(descriptor);
    }
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

  it("uses the opt-in long-word fallback in word-preserving bubble slots", () => {
    const slots = [
      {
        blockOffsetPx: 0,
        inlineOffsetPx: 0,
        availableWidth: 30,
        regionIndex: 0,
      },
      {
        blockOffsetPx: 12,
        inlineOffsetPx: 0,
        availableWidth: 30,
        regionIndex: 0,
      },
      {
        blockOffsetPx: 24,
        inlineOffsetPx: 0,
        availableWidth: 30,
        regionIndex: 0,
      },
    ];
    const measured = measureStyledWrappedTextInSlots(
      fixedMeasureContext,
      plainRuns("abcdefgh"),
      slots,
      12,
      10,
      "sans-serif",
      0,
      "keep-all-overflow",
    );

    expect(lineTexts(measured.lines)).toEqual(["abc", "def", "gh"]);
    expect(measured.consumedAll).toBe(true);
    expect(measured.fits).toBe(true);
  });

  it("keeps an empty paragraph in its first bubble slot", () => {
    const slot = {
      blockOffsetPx: 12,
      inlineOffsetPx: 8,
      availableWidth: 40,
      regionIndex: 0,
    };
    const measured = measureStyledWrappedTextInSlots(
      fixedMeasureContext,
      plainRuns(""),
      [slot],
      12,
      10,
      "sans-serif",
      0,
      "normal",
    );

    expect(lineTexts(measured.lines)).toEqual([""]);
    expect(measured.lines[0]?.slot).toEqual(slot);
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

function restoreIntlSegmenter(
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(Intl, "Segmenter", descriptor);
    return;
  }
  Reflect.deleteProperty(Intl, "Segmenter");
}

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
