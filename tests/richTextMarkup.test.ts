import { describe, expect, it } from "vitest";
import {
  parseRichText,
  stripRichTextMarkup,
} from "../src/shared/richTextMarkup";

describe("parseRichText", () => {
  it("marks **bold** and *italic* spans independently", () => {
    const { runs, plainText } = parseRichText("이건 **중요**하고 *기울임*임");
    expect(plainText).toBe("이건 중요하고 기울임임");
    expect(runs).toEqual([
      { text: "이건 ", bold: false, italic: false },
      { text: "중요", bold: true, italic: false },
      { text: "하고 ", bold: false, italic: false },
      { text: "기울임", bold: false, italic: true },
      { text: "임", bold: false, italic: false },
    ]);
  });

  it("treats ***...*** as bold and italic together", () => {
    const { runs } = parseRichText("***둘다***");
    expect(runs).toEqual([{ text: "둘다", bold: true, italic: true }]);
  });

  it("renders escaped asterisks as literal characters", () => {
    const { runs, plainText } = parseRichText("\\*별표\\*");
    expect(plainText).toBe("*별표*");
    expect(runs).toEqual([{ text: "*별표*", bold: false, italic: false }]);
  });

  it("keeps unclosed markers as literal text", () => {
    const { plainText, runs } = parseRichText("이건 **중요");
    expect(plainText).toBe("이건 **중요");
    expect(runs.every((run) => !run.bold && !run.italic)).toBe(true);
  });

  it("preserves newlines", () => {
    const { plainText } = parseRichText("첫 줄\n**둘째** 줄");
    expect(plainText).toBe("첫 줄\n둘째 줄");
  });

  it("composes block-wide emphasis with inline markers", () => {
    const { runs } = parseRichText("보통 *기울임*", true, false);
    expect(runs).toEqual([
      { text: "보통 ", bold: true, italic: false },
      { text: "기울임", bold: true, italic: true },
    ]);
  });

  it("supports italic nested inside bold", () => {
    const { runs } = parseRichText("**굵게 *그리고* 기울임**");
    expect(runs).toEqual([
      { text: "굵게 ", bold: true, italic: false },
      { text: "그리고", bold: true, italic: true },
      { text: " 기울임", bold: true, italic: false },
    ]);
  });

  it("never emits markup as part of plain text width", () => {
    expect(stripRichTextMarkup("a**b**c")).toBe("abc");
    expect(stripRichTextMarkup("plain")).toBe("plain");
  });
});
