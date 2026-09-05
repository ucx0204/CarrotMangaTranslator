import { assert, describe, expect, it } from "vitest";
import {
  compareBalancedParagraphs,
  measureBalancedBubbleParagraph,
} from "../src/renderer/src/lib/balancedBubbleTextWrapping";
import type {
  StyledGrapheme,
  TextLineSlot,
} from "../src/renderer/src/lib/overlayTextWrapping";

const glyphs = (text: string): StyledGrapheme[] =>
  Array.from(text).map((text, i) => ({
    text,
    width: text === " " ? 8 : 20,
    bold: i === 0,
    italic: false,
  }));
const slots = (widths: number[]): TextLineSlot[] =>
  widths.map((availableWidth, i) => ({
    availableWidth,
    blockOffsetPx: i * 24,
    inlineOffsetPx: 0,
    regionIndex: 0,
  }));

describe("balanced source-matched paragraph", () => {
  it("uses fewer complete rows before rewarding a thin column's equal widths", () => {
    const text = glyphs("작은 문단을 온전히 배치해 주세요");
    const compact = measureBalancedBubbleParagraph(
      text,
      slots([160, 160, 160]),
      24,
      0,
      "keep-all-overflow",
    );
    const thin = measureBalancedBubbleParagraph(
      text,
      slots([160, 160, 160, 160, 160]),
      24,
      0,
      "keep-all-overflow",
    );
    assert(compact);
    assert(thin);
    expect(compact.wordSplitCount).toBe(0);
    expect(compareBalancedParagraphs(compact, thin)).toBeLessThan(0);
  });

  it("protects a whole word before a forced punctuation row", () => {
    const result = measureBalancedBubbleParagraph(
      glyphs("아아! 성녀님!!"),
      slots([80, 80, 80]),
      24,
      0,
      "keep-all-overflow",
    );
    expect(
      result?.lines.map((line) => line.runs.map((run) => run.text).join("")),
    ).toEqual(["아아!", "성녀님", "!!"]);
    expect(result?.wordSplitCount).toBe(0);
    expect(result?.fragmentLineCount).toBe(1);
  });
  it("keeps inter-sentence punctuation attached to its preceding word", () => {
    const source = "어라. 성녀님";
    const result = measureBalancedBubbleParagraph(
      glyphs(source),
      slots([40, 90, 90]),
      24,
      0,
      "keep-all-overflow",
    );
    assert(result);
    const lines = result.lines.map((line) =>
      line.runs.map((run) => run.text).join(""),
    );
    expect(lines).not.toContain(". 성녀님");
    expect(lines.every((line) => !/^[.,!?]/u.test(line))).toBe(true);
    expect(lines.join("").replace(/\s/gu, "")).toBe(source.replace(/\s/gu, ""));
  });

  it("keeps short words together and distributes an unavoidable long-word split", () => {
    const source = "옷장에 있는 것 중에서 고르겠습니다만…";
    const result = measureBalancedBubbleParagraph(
      glyphs(source),
      slots([90, 90, 90, 90, 90, 90]),
      24,
      0,
      "keep-all-overflow",
    );
    assert(result);
    const lines = result.lines.map((line) =>
      line.runs.map((run) => run.text).join(""),
    );
    expect(lines.join("").replace(/\s/gu, "")).toBe(source.replace(/\s/gu, ""));
    expect(
      result.lines.reduce(
        (sum, line) =>
          sum +
          (line.sourceTextLength ??
            line.runs.map((r) => r.text).join("").length),
        0,
      ),
    ).toBe(source.length);
    expect(result.lines[0].runs[0].bold).toBe(true);
    expect(
      result.lines.every(
        (line) => line.width <= (line.slot?.availableWidth ?? 0),
      ),
    ).toBe(true);
  });

  it("keeps a fitting word whole when only its trailing space exceeds the slot", () => {
    const result = measureBalancedBubbleParagraph(
      glyphs("상관없어! 정말"),
      slots([100, 60]),
      24,
      0,
      "keep-all-overflow",
    );
    expect(
      result?.lines.map((line) => line.runs.map((run) => run.text).join("")),
    ).toEqual(["상관없어!", "정말"]);
    expect(result?.wordSplitCount).toBe(0);
    expect(result?.lines[0].width).toBe(100);
  });

  it("does not orphan closing punctuation or violate strict keep-all", () => {
    const text = "수상한 무리라고?";
    const result = measureBalancedBubbleParagraph(
      glyphs(text),
      slots([90, 100]),
      24,
      0,
      "keep-all",
    );
    assert(result);
    expect(
      result.lines
        .at(-1)
        ?.runs.map((run) => run.text)
        .join(""),
    ).toBe("무리라고?");
    expect(
      measureBalancedBubbleParagraph(
        glyphs("감사합니다만"),
        slots([80, 80]),
        24,
        0,
        "keep-all",
      ),
    ).toBeNull();
    expect(
      measureBalancedBubbleParagraph(
        glyphs("수동\n개행"),
        slots([90, 90]),
        24,
        0,
        "keep-all-overflow",
      ),
    ).toBeNull();
  });
});
