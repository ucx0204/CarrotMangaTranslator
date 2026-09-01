import { describe, expect, it } from "vitest";
import {
  applyTextStyleToRuns,
  clearTextStylesFromRuns,
  parseRichText,
  serializeRichTextRuns,
  stripRichTextMarkup,
  type TextStyleRun,
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

  it("parses nested absolute size, font, opacity, and emphasis tags", () => {
    const { plainText, runs } = parseRichText(
      "앞[font=custom-123][size=48.5]**큰 글자**[/size][/font]" +
        "[opacity=35]옅게[/opacity]",
    );

    expect(plainText).toBe("앞큰 글자옅게");
    expect(runs).toEqual([
      { text: "앞", bold: false, italic: false },
      {
        text: "큰 글자",
        bold: true,
        italic: false,
        sizePx: 48.5,
        fontFamily: "custom-123",
      },
      { text: "옅게", bold: false, italic: false, opacity: 0.35 },
    ]);
  });

  it("keeps malformed, unsafe, and unclosed style tags literal", () => {
    const value =
      "[size=999]큼[/size] [font=bad font]폰트[/font] [opacity=20]안 닫힘";
    expect(parseRichText(value).plainText).toBe(value);
  });

  it("supports escaped brackets, asterisks, and backslashes", () => {
    expect(parseRichText("\\[size=20]그대로\\* \\\\").plainText).toBe(
      "[size=20]그대로* \\",
    );
  });

  it("serializes safe style runs deterministically and round-trips them", () => {
    const runs = [
      { text: "보통 * [", bold: false, italic: false },
      {
        text: "강조",
        bold: true,
        italic: true,
        sizePx: 42.5,
        fontFamily: "mgt-jua",
        opacity: 0.75,
      },
    ];
    const serialized = serializeRichTextRuns(runs);

    expect(serialized).toBe(
      "보통 \\* \\[" +
        "[font=mgt-jua][size=42.5][opacity=75]***강조***[/opacity][/size][/font]",
    );
    expect(parseRichText(serialized).runs).toEqual(runs);
  });

  it("applies and clears formatting only inside a plain-text selection", () => {
    const initial = parseRichText("가나다라").runs;
    const formatted = applyTextStyleToRuns(initial, 1, 3, {
      sizePx: 30,
      fontFamily: "mgt-jua",
      opacity: 0.4,
    });

    expect(formatted).toEqual([
      { text: "가", bold: false, italic: false },
      {
        text: "나다",
        bold: false,
        italic: false,
        sizePx: 30,
        fontFamily: "mgt-jua",
        opacity: 0.4,
      },
      { text: "라", bold: false, italic: false },
    ]);
    expect(clearTextStylesFromRuns(formatted, 1, 3)).toEqual(initial);
  });

  it("preserves nested same-kind tags without confusing their closing tags", () => {
    const parsed = parseRichText("[size=20]가[size=40]나[/size]다[/size]");
    expect(parsed.runs).toEqual([
      { text: "가", bold: false, italic: false, sizePx: 20 },
      { text: "나", bold: false, italic: false, sizePx: 40 },
      { text: "다", bold: false, italic: false, sizePx: 20 },
    ]);
  });

  it("round-trips the complete per-character visual style set", () => {
    const runs = [
      {
        text: "효과",
        bold: true,
        italic: false,
        underline: true,
        strikethrough: true,
        emphasisMark: true,
        sizePx: 36,
        fontFamily: "mgt-effect",
        opacity: 0.8,
        widthScale: 1.25,
        color: "#112233",
        backgroundColor: "#fefefe",
        outlineColor: "#ffffff",
        outlineWidthPx: 2,
        outerOutlineColor: "#000000",
        outerOutlineWidthPx: 3,
        glowColor: "#ff8800",
        glowBlurPx: 6,
        glowOpacity: 0.65,
      },
    ] satisfies TextStyleRun[];

    const serialized = serializeRichTextRuns(runs);
    expect(parseRichText(serialized).runs).toEqual(runs);
    expect(parseRichText(serialized).plainText).toBe("효과");
    expect(clearTextStylesFromRuns(runs)).toEqual([
      { text: "효과", bold: false, italic: false },
    ]);
  });
});
