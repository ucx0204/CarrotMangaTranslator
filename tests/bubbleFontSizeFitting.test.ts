import { describe, expect, it } from "vitest";
import { selectSourceMatchedParagraphSize } from "../src/renderer/src/lib/bubbleFontSizeFitting";
import type { SlottedWrappedTextMeasurement } from "../src/renderer/src/lib/bubbleTextWrapping";

function paragraph(parts: string[]): SlottedWrappedTextMeasurement {
  return {
    fits: true,
    consumedAll: true,
    totalHeight: parts.length * 30,
    lineCount: parts.length,
    maxLineWidth: 100,
    lines: parts.map((part) => ({
      width: 100,
      sourceTextLength: part.length,
      runs: [{ text: part.trimEnd(), bold: false, italic: false }],
    })),
  };
}

describe("source matched paragraph size", () => {
  it("keeps the largest undamaged paragraph even if a smaller one uses fewer lines", () => {
    expect(
      selectSourceMatchedParagraphSize("온전한 문단 유지", 30, (size) =>
        paragraph(size >= 29 ? ["온전한 ", "문단 유지"] : ["온전한 문단 유지"]),
      ),
    ).toBe(30);
  });
  it("joins a new one-character word with a nearby size", () => {
    expect(
      selectSourceMatchedParagraphSize(
        "멀리 떠나는 걸 허락할 리 없지.",
        28,
        (size) =>
          paragraph(
            size === 28
              ? ["멀리 ", "떠나는 ", "걸 ", "허락할 ", "리 없지."]
              : ["멀리 ", "떠나는 걸 ", "허락할 ", "리 없지."],
          ),
      ),
    ).toBe(27);
  });
  it("crosses a failed intermediate size to attach punctuation without splitting the word", () => {
    expect(
      selectSourceMatchedParagraphSize("응, 움직이겠네.", 28, (size) => {
        if (size >= 26) return paragraph(["응, ", "움직이겠네", "."]);
        if (size === 25) return null;
        return paragraph(["응, ", "움직이겠네."]);
      }),
    ).toBe(24);
  });
  it("does not shrink when the damage cannot improve in the readable range", () => {
    expect(
      selectSourceMatchedParagraphSize("너 말이다…", 41, () =>
        paragraph(["너 ", "말이다", "…"]),
      ),
    ).toBe(41);
  });
  it("preserves a short reaction and an all-punctuation utterance", () => {
    expect(
      selectSourceMatchedParagraphSize("아!", 35, () => paragraph(["아!"])),
    ).toBe(35);
    expect(
      selectSourceMatchedParagraphSize("!!!", 35, () => paragraph(["!", "!!"])),
    ).toBe(35);
  });
});
