/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import type { TextStyleRun } from "../src/shared/richTextMarkup";
import {
  clearRichTextEditorSelectionPreview,
  extractRichTextEditorRuns,
  getRichTextEditorCaretRun,
  getRichTextEditorSelection,
  insertPlainTextAtEditorSelection,
  renderRichTextEditorRuns,
  restoreRichTextEditorSelection,
} from "../src/renderer/src/lib/richTextEditorDom";

const options = {
  baseBold: false,
  baseItalic: false,
  baseFontSizePx: 20,
  baseFontFamily: "sans-serif",
  baseOpacity: 1,
  resolveFontFamily: (id: string | undefined) =>
    id === "display" ? "Display Font" : "sans-serif",
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("rich text editor DOM", () => {
  it("renders and extracts only supported safe run attributes", () => {
    const root = makeRoot();
    const runs: TextStyleRun[] = [
      { text: "보통 ", bold: false, italic: false },
      {
        text: "큰 글자",
        bold: true,
        italic: true,
        sizePx: 40,
        fontFamily: "display",
        opacity: 0.45,
        underline: true,
        strikethrough: true,
        emphasisMark: true,
        widthScale: 1.2,
        color: "#112233",
        backgroundColor: "#fefefe",
        outlineColor: "#ffffff",
        outlineWidthPx: 2,
        outerOutlineColor: "#000000",
        outerOutlineWidthPx: 3,
        glowColor: "#ff8800",
        glowBlurPx: 6,
        glowOpacity: 0.65,
        verticalCombine: true,
      },
    ];

    renderRichTextEditorRuns(root, runs, options);
    const styled = root.querySelectorAll(
      "[data-rich-text-run]",
    )[1] as HTMLElement;
    expect(styled.style.fontSize).toBe("32px");
    expect(styled.style.fontFamily).toContain("Display Font");
    expect(styled.style.opacity).toBe("0.45");
    expect(extractRichTextEditorRuns(root)).toEqual(runs);
  });

  it("maps a visual selection to stable plain-text offsets and restores it", () => {
    const root = makeRoot();
    renderRichTextEditorRuns(
      root,
      [
        { text: "가나", bold: false, italic: false },
        { text: "다라", bold: true, italic: false },
      ],
      options,
    );

    restoreRichTextEditorSelection(root, { start: 1, end: 3 });
    expect(getRichTextEditorSelection(root)).toEqual({ start: 1, end: 3 });
    expect(document.getSelection()?.toString()).toBe("나다");
  });

  it("reads the actual style run at a collapsed visual caret", () => {
    const root = makeRoot();
    renderRichTextEditorRuns(
      root,
      [
        { text: "기본", bold: false, italic: false },
        {
          text: "꾸밈",
          bold: true,
          italic: false,
          sizePx: 48,
          opacity: 0.6,
        },
      ],
      options,
    );
    const styledText = root.querySelectorAll("[data-rich-text-run]")[1]
      ?.firstChild;
    if (!styledText) throw new Error("Expected styled text node");
    const range = document.createRange();
    range.setStart(styledText, 1);
    range.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    expect(getRichTextEditorCaretRun(root)).toEqual({
      text: "",
      bold: true,
      italic: false,
      sizePx: 48,
      opacity: 0.6,
    });
  });

  it("keeps a saved selection visibly marked while formatting controls own focus", () => {
    const root = makeRoot();
    const runs: TextStyleRun[] = [
      { text: "가나다라", bold: false, italic: false },
    ];

    renderRichTextEditorRuns(root, runs, options, { start: 1, end: 3 });

    expect(
      Array.from(root.querySelectorAll("[data-rich-text-selection]"))
        .map((element) => element.textContent)
        .join(""),
    ).toBe("나다");
    expect(extractRichTextEditorRuns(root)).toEqual(runs);
    clearRichTextEditorSelectionPreview(root);
    expect(root.querySelector("[data-rich-text-selection]")).toBeNull();
  });

  it("pastes plain text without preserving arbitrary external HTML", () => {
    const root = makeRoot();
    renderRichTextEditorRuns(
      root,
      [{ text: "앞뒤", bold: false, italic: false }],
      options,
    );
    restoreRichTextEditorSelection(root, { start: 1, end: 1 });

    expect(insertPlainTextAtEditorSelection(root, "<b>삽입</b>")).toBe(true);
    expect(root.querySelector("b")).toBeNull();
    expect(extractRichTextEditorRuns(root)[0]?.text).toBe("앞<b>삽입</b>뒤");
  });

  it("normalizes browser-created block elements to explicit newlines", () => {
    const root = makeRoot();
    root.innerHTML =
      '<span data-rich-text-run data-bold="false" data-italic="false">첫 줄</span>' +
      '<div><span data-rich-text-run data-bold="true" data-italic="false">둘째 줄</span></div>';

    expect(extractRichTextEditorRuns(root)).toEqual([
      { text: "첫 줄\n", bold: false, italic: false },
      { text: "둘째 줄", bold: true, italic: false },
    ]);
  });
});

function makeRoot(): HTMLDivElement {
  const root = document.createElement("div");
  root.contentEditable = "true";
  document.body.append(root);
  return root;
}
