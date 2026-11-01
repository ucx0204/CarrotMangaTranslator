/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { chooseCustomSelectOption } from "./testUtils/customSelect";
import type { PanelFormatSelection } from "../src/shared/panelBridgeTypes";
import { parseRichText } from "../src/shared/richTextMarkup";
import type { TranslationBlock } from "../src/shared/textTypes";
import { EditorPanel } from "../src/renderer/src/components/EditorPanel";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText(this: { font: string }, text: string) {
        const fontSize = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 16);
        return {
          width: Array.from(text).length * fontSize,
          actualBoundingBoxAscent: fontSize * 0.8,
          actualBoundingBoxDescent: fontSize * 0.2,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: fontSize,
        };
      },
    }),
  });
});

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("integrated character formatting scope", () => {
  it("edits a whole-block property and keeps unrelated letter styles", () => {
    const onUpdate = vi.fn();
    const view = renderPanel(
      makeBlock({ translatedText: "가[color=#ff0000]나[/color]다" }),
      { onUpdate },
    );

    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");
    const leading = numberField("줄 간격");
    expect(leading.value).toBe("118");
    commitNumber(leading, "140");
    // No partial leading existed, so the markup (and its red letter) is kept.
    expect(onUpdate).toHaveBeenLastCalledWith({ lineHeight: 1.4 });

    onUpdate.mockClear();
    view.rerender(
      panelView(
        makeBlock({
          translatedText:
            "가[line-height=1.6]나[/line-height][color=#ff0000]다[/color]",
        }),
        { onUpdate },
      ),
    );
    expect(numberField("줄 간격").value).toBe("");
    commitNumber(numberField("줄 간격"), "130");
    const patch = onUpdate.mock.lastCall?.[0] as Partial<TranslationBlock>;
    expect(patch.lineHeight).toBe(1.3);
    const runs = parseRichText(patch.translatedText ?? "").runs;
    expect(runs.some((run) => run.lineHeight !== undefined)).toBe(false);
    expect(runs.find((run) => run.text === "다")?.color).toBe("#ff0000");
  });

  it("formats only a selected range and reports mixed letter values", () => {
    const onUpdate = vi.fn();
    renderPanel(makeBlock({ translatedText: "가[size=40]나[/size]다라" }), {
      onUpdate,
    });

    selectPlainRange(0, 2);
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
    expect(numberField("글자 크기 값").value).toBe("");
    const bold = within(characterRegion()).getByRole("button", {
      name: "굵게",
    });
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bold);

    const text = lastTranslatedText(onUpdate);
    expect(boldLetters(text)).toBe("가나");
    expect(parseRichText(text).plainText).toBe("가나다라");
  });

  it("keeps the selected range through font and color popups", () => {
    const onUpdate = vi.fn();
    renderPanel(makeBlock({ translatedText: "가나다라" }), { onUpdate });

    selectPlainRange(1, 3);
    const fontTrigger = within(characterRegion()).getByRole("combobox", {
      name: "폰트",
    });
    fireEvent.pointerDown(fontTrigger);
    chooseCustomSelectOption("폰트", /나눔고딕/);
    const withFont = lastTranslatedText(onUpdate);
    expect(
      lettersWith(withFont, (run) => run.fontFamily === "nanum-gothic"),
    ).toBe("나다");

    const color = within(characterRegion()).getByRole("textbox", {
      name: "글자색 HEX",
    });
    fireEvent.pointerDown(color);
    fireEvent.change(color, { target: { value: "#2255aa" } });
    const withColor = lastTranslatedText(onUpdate);
    expect(lettersWith(withColor, (run) => run.color === "#2255aa")).toBe(
      "나다",
    );
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
  });

  it("returns to whole-block scope when another block is selected", () => {
    const onUpdate = vi.fn();
    const view = renderPanel(makeBlock({ translatedText: "가나다라" }), {
      onUpdate,
    });
    selectPlainRange(1, 3);
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");

    view.rerender(
      panelView(makeBlock({ id: "block-2", translatedText: "마바사" }), {
        onUpdate,
      }),
    );
    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");
    fireEvent.click(
      within(characterRegion()).getByRole("button", { name: "굵게" }),
    );
    expect(onUpdate).toHaveBeenLastCalledWith({ bold: true });
  });

  it("selects all text, an output line, and finishes editing", () => {
    const onPreviewTextSelection = vi.fn();
    renderPanel(makeBlock({ translatedText: "가나\n다라" }), {
      onPreviewTextSelection,
      pageSize: { width: 1000, height: 1000 },
      resolvedFontSizePx: 24,
    });
    // Selection commands live with the text they select, under the input.
    const region = screen.getByRole("region", { name: "번역문" });
    expect(
      within(characterRegion()).queryByRole("button", { name: "전체 선택" }),
    ).toBeNull();
    expect(
      within(region).queryByRole("button", { name: "출력 줄 선택" }),
    ).toBeNull();

    fireEvent.click(within(region).getByRole("button", { name: "전체 선택" }));
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
    expect(onPreviewTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 0, end: 5 }),
    );

    selectPlainRange(4, 4);
    expect(scopeStatus()).toBe("적용 대상: 이후 입력할 글자");
    fireEvent.click(
      within(region).getByRole("button", { name: "출력 줄 선택" }),
    );
    expect(onPreviewTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 3, end: 5 }),
    );

    fireEvent.click(within(region).getByRole("button", { name: "편집 종료" }));
    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");
    expect(onPreviewTextSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 0, end: 0 }),
    );
  });

  it("does not replay a previous edit request when the selected block changes", () => {
    const view = renderPanel(makeBlock(), { editorTextTabRequestToken: 0 });
    view.rerender(panelView(makeBlock(), { editorTextTabRequestToken: 1 }));
    expect(scopeStatus()).toBe("적용 대상: 이후 입력할 글자");
    view.rerender(
      panelView(makeBlock({ id: "new-block" }), {
        editorTextTabRequestToken: 1,
      }),
    );
    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");
    view.rerender(
      panelView(makeBlock({ id: "new-block" }), {
        editorTextTabRequestToken: 2,
      }),
    );
    expect(scopeStatus()).toBe("적용 대상: 이후 입력할 글자");
  });

  it("returns to block scope on canvas reselection of the same block", () => {
    const view = renderPanel(makeBlock(), { editorTextResetToken: 0 });
    selectPlainRange(0, 1);
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
    view.rerender(panelView(makeBlock(), { editorTextResetToken: 1 }));
    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");
    view.rerender(
      panelView(makeBlock(), {
        editorTextResetToken: 1,
        editorTextTabRequestToken: 1,
      }),
    );
    expect(scopeStatus()).toBe("적용 대상: 이후 입력할 글자");
    view.rerender(
      panelView(makeBlock(), {
        editorTextResetToken: 2,
        editorTextTabRequestToken: 0,
      }),
    );
    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");
    view.rerender(
      panelView(makeBlock(), {
        editorTextResetToken: 2,
        editorTextTabRequestToken: 1,
      }),
    );
    expect(scopeStatus()).toBe("적용 대상: 이후 입력할 글자");
  });

  it("keeps code mode for select-all and clears pending style after moving the caret", () => {
    window.localStorage.setItem("editor.richText.mode", "code");
    renderPanel(makeBlock({ translatedText: "가나다" }));
    const editor = screen.getByRole("textbox", {
      name: "번역문 서식 코드",
    }) as HTMLTextAreaElement;
    fireEvent.focus(editor);
    editor.setSelectionRange(1, 1);
    fireEvent.select(editor);
    commitNumber(numberField("줄 간격"), "200");
    expect(numberField("줄 간격").value).toBe("200");
    editor.setSelectionRange(2, 2);
    fireEvent.select(editor);
    expect(numberField("줄 간격").value).toBe("118");
    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    expect(screen.getByRole("textbox", { name: "번역문 서식 코드" })).toBe(
      editor,
    );
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([0, 3]);
  });

  it("applies caret leading to a completed Korean code composition exactly once", () => {
    window.localStorage.setItem("editor.richText.mode", "code");
    const onUpdate = vi.fn();
    renderPanel(makeBlock({ translatedText: "가나" }), { onUpdate });
    const editor = screen.getByRole("textbox", {
      name: "번역문 서식 코드",
    }) as HTMLTextAreaElement;
    fireEvent.focus(editor);
    editor.setSelectionRange(1, 1);
    fireEvent.select(editor);
    commitNumber(numberField("줄 간격"), "200");
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: "가ㅎ나" } });
    fireEvent.change(editor, { target: { value: "가한나" } });
    fireEvent.compositionEnd(editor);
    const result = lastTranslatedText(onUpdate);
    expect(parseRichText(result).plainText).toBe("가한나");
    expect(lettersWith(result, (run) => run.lineHeight === 2)).toBe("한");
    fireEvent.change(editor, { target: { value: "가한나" } });
    expect(lastTranslatedText(onUpdate)).toBe(result);
  });

  it("changing mixed glow blur preserves both character colors and opacity", () => {
    const onUpdate = vi.fn();
    const text =
      "[glow-color=#ff0000][glow-blur=4][glow-opacity=0.4]가[/glow-opacity][/glow-blur][/glow-color]" +
      "[glow-color=#0000ff][glow-blur=8][glow-opacity=0.8]나[/glow-opacity][/glow-blur][/glow-color]";
    renderPanel(makeBlock({ translatedText: text }), { onUpdate });
    selectPlainRange(0, 2);
    fireEvent.click(screen.getByRole("button", { name: "상세 문자 효과" }));
    const effects = screen.getByRole("region", { name: "상세 문자 효과" });
    const blur = within(effects).getByRole("spinbutton", {
      name: "퍼짐",
    }) as HTMLInputElement;
    expect(blur.value).toBe("");
    commitNumber(blur, "6");
    const runs = parseRichText(lastTranslatedText(onUpdate)).runs;
    expect(
      runs.map((run) => [
        run.text,
        run.glowColor,
        run.glowOpacity,
        run.glowBlurPx,
      ]),
    ).toEqual([
      ["가", "#ff0000", 0.4, 6],
      ["나", "#0000ff", 0.8, 6],
    ]);
  });

  it("reflects external undo in a focused editor after its local edit was acknowledged", () => {
    window.localStorage.setItem("editor.richText.mode", "code");
    const onUpdate = vi.fn();
    const view = renderPanel(makeBlock({ translatedText: "가나" }), {
      onUpdate,
    });
    const editor = screen.getByRole("textbox", {
      name: "번역문 서식 코드",
    }) as HTMLTextAreaElement;
    act(() => editor.focus());
    fireEvent.change(editor, { target: { value: "가나다" } });
    view.rerender(
      panelView(makeBlock({ translatedText: "가나다" }), { onUpdate }),
    );
    expect(editor.value).toBe("가나다");
    view.rerender(
      panelView(makeBlock({ translatedText: "가나" }), { onUpdate }),
    );
    expect(editor.value).toBe("가나");
  });

  it("formats every selected block until a letter range is edited", () => {
    const onUpdate = vi.fn();
    const onUpdateFormat = vi.fn();
    const formatSelection: PanelFormatSelection = {
      common: {},
      mixedFields: ["bold", "lineHeight"],
    };
    renderPanel(makeBlock({ translatedText: "가나다" }), {
      formatSelection,
      onUpdate,
      onUpdateFormat,
      selectedBlockCount: 2,
      selectionKey: '["block-1","block-2"]',
    });

    expect(scopeStatus()).toBe("적용 대상: 선택한 블록 2개의 모든 글자");
    expect(screen.getByText("선택한 블록 2개 전체에 적용됩니다.")).toBeTruthy();
    const bold = within(characterRegion()).getByRole("button", {
      name: "굵게",
    });
    expect(bold.getAttribute("aria-pressed")).toBe("mixed");
    expect(numberField("줄 간격").value).toBe("");
    fireEvent.click(bold);
    expect(onUpdateFormat).toHaveBeenLastCalledWith({ bold: true });
    commitNumber(numberField("줄 간격"), "125");
    expect(onUpdateFormat).toHaveBeenLastCalledWith({ lineHeight: 1.25 });
    expect(onUpdate).not.toHaveBeenCalled();

    selectPlainRange(0, 1);
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
    fireEvent.click(
      within(characterRegion()).getByRole("button", { name: "굵게" }),
    );
    expect(boldLetters(lastTranslatedText(onUpdate))).toBe("가");
    expect(onUpdateFormat).toHaveBeenCalledTimes(2);
  });

  it("marks block-wide settings and keeps them out of letter scope", () => {
    const onUpdate = vi.fn();
    renderPanel(makeBlock({ translatedText: "가나다" }), { onUpdate });
    selectPlainRange(0, 1);

    const settings = screen.getByRole("region", { name: "블록 전체 설정" });
    // The title names the scope; a single block needs no extra sentence.
    expect(
      within(settings).queryByText(
        "글자 선택과 관계없이 항상 블록 전체에 적용됩니다.",
      ),
    ).toBeNull();
    fireEvent.click(
      within(settings).getByRole("button", { name: "가운데 정렬" }),
    );
    expect(onUpdate).toHaveBeenLastCalledWith({ textAlign: "center" });
    expect(within(settings).queryByRole("button", { name: "굵게" })).toBeNull();
    // Shadow is a letter effect now, so the block group has no second copy.
    expect(
      within(settings).queryByRole("checkbox", { name: "그림자 사용" }),
    ).toBeNull();
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
  });

  it("puts a shadow on the selected letters only, one field at a time", () => {
    const onUpdate = vi.fn();
    const view = renderPanel(makeBlock({ translatedText: "가나다라" }), {
      onUpdate,
    });
    selectPlainRange(1, 3);
    fireEvent.click(screen.getByRole("button", { name: "상세 문자 효과" }));
    const effects = screen.getByRole("region", { name: "상세 문자 효과" });
    fireEvent.click(
      within(effects).getByRole("checkbox", { name: "그림자 사용" }),
    );
    const enabled = lastTranslatedText(onUpdate);
    expect(lettersWith(enabled, (run) => run.shadowEnabled === true)).toBe(
      "나다",
    );
    expect(parseRichText(enabled).plainText).toBe("가나다라");

    view.rerender(
      panelView(makeBlock({ translatedText: enabled }), { onUpdate }),
    );
    selectPlainRange(1, 3);
    commitNumber(
      within(screen.getByRole("region", { name: "상세 문자 효과" })).getByRole(
        "spinbutton",
        { name: "X 위치" },
      ),
      "-6",
    );
    const moved = parseRichText(lastTranslatedText(onUpdate)).runs;
    expect(
      moved
        .filter((run) => run.shadowOffsetXpx === -6)
        .map((run) => run.text)
        .join(""),
    ).toBe("나다");
    // Only the edited field was sent: the other letters stay shadow-free.
    expect(
      moved
        .filter((run) => run.text.includes("가") || run.text.includes("라"))
        .every((run) => run.shadowEnabled !== true),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "상세 문자 효과" }).closest("header")
        ?.textContent,
    ).toContain("그림자");
  });

  it("folds the selection commands away with the translation they select", () => {
    renderPanel(makeBlock({ translatedText: "가나다" }));
    const translation = screen.getByRole("button", { name: "번역문" });
    fireEvent.click(translation);
    expect(translation.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "전체 선택" })).toBeNull();
    // Letter formatting stays reachable and targets the whole block.
    expect(scopeStatus()).toBe("적용 대상: 블록 전체 글자");

    fireEvent.click(translation);
    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    expect(scopeStatus()).toBe("적용 대상: 선택한 글자");
  });

  it("names active effects on the folded effects header", () => {
    renderPanel(
      makeBlock({
        outlineWidthPx: 2,
        outlineColor: "#ffffff",
        textGlow: { enabled: true, color: "#ffffff", blurPx: 4, opacity: 0.7 },
      }),
    );
    const effects = screen.getByRole("button", { name: "상세 문자 효과" });
    expect(effects.getAttribute("aria-expanded")).toBe("false");
    const header = effects.closest("header");
    expect(header?.textContent).toContain("외곽선 · 광선");

    cleanup();
    renderPanel(makeBlock({ outlineWidthPx: 0 }));
    expect(
      screen.getByRole("button", { name: "상세 문자 효과" }).closest("header")
        ?.textContent,
    ).toBe("›상세 문자 효과");
  });

  it("keeps OCR image actions on the OCR title row while folded", () => {
    const onEraseOriginal = vi.fn();
    renderPanel(makeBlock(), { onEraseOriginal, onFitBubble: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "원문 OCR" }));
    expect(screen.queryByRole("textbox", { name: "원문 OCR" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "이 블록 원문 지우기" }),
    );
    expect(onEraseOriginal).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "이 블록을 말풍선에 맞춤" }),
    ).toBeTruthy();
  });

  it("remembers collapsed sections and starts effects collapsed", () => {
    const first = renderPanel(makeBlock());
    expect(
      screen
        .getByRole("button", { name: "상세 문자 효과" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    const ocr = screen.getByRole("textbox", { name: "원문 OCR" });
    expect(ocr.getAttribute("rows")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "원문 OCR" }));
    expect(screen.queryByRole("textbox", { name: "원문 OCR" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "상세 문자 효과" }));
    first.unmount();

    renderPanel(makeBlock({ id: "block-2" }));
    expect(screen.queryByRole("textbox", { name: "원문 OCR" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "상세 문자 효과" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("checkbox", { name: "광선" })).toBeTruthy();
  });
});

type PanelOptions = Partial<React.ComponentProps<typeof EditorPanel>>;

function panelView(
  block: TranslationBlock,
  options: PanelOptions = {},
): React.JSX.Element {
  return (
    <FontsTestProvider>
      <EditorPanel
        block={block}
        disabled={false}
        onAdjustFontSize={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onUpdate={vi.fn()}
        {...options}
      />
    </FontsTestProvider>
  );
}

function renderPanel(block: TranslationBlock, options: PanelOptions = {}) {
  return render(panelView(block, options));
}

function characterRegion(): HTMLElement {
  return screen.getByRole("region", { name: "문자 서식" });
}

function scopeStatus(): string | null {
  return within(characterRegion()).getByRole("status").textContent;
}

function numberField(name: string): HTMLInputElement {
  return within(characterRegion()).getByRole("spinbutton", {
    name,
  }) as HTMLInputElement;
}

function commitNumber(input: HTMLElement, value: string): void {
  fireEvent.pointerDown(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

/** Focuses the visual editor and selects plain-text offsets across runs. */
function selectPlainRange(start: number, end: number): void {
  const editor = screen.getByRole("textbox", { name: "번역문" });
  act(() => editor.focus());
  const range = document.createRange();
  setBoundary(editor, start, (node, offset) => range.setStart(node, offset));
  setBoundary(editor, end, (node, offset) => range.setEnd(node, offset));
  act(() => {
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function setBoundary(
  root: HTMLElement,
  target: number,
  apply: (node: Node, offset: number) => void,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    last = text;
    if (consumed + text.length >= target) {
      apply(text, target - consumed);
      return;
    }
    consumed += text.length;
  }
  if (!last) throw new Error("Expected editor text");
  apply(last, last.length);
}

function lastTranslatedText(update: ReturnType<typeof vi.fn>): string {
  const calls = update.mock.calls as [Partial<TranslationBlock>][];
  const patch = [...calls]
    .reverse()
    .find(([value]) => typeof value.translatedText === "string");
  if (!patch) throw new Error("Expected a translated text update");
  return patch[0].translatedText as string;
}

function lettersWith(
  value: string,
  predicate: (run: ReturnType<typeof parseRichText>["runs"][number]) => boolean,
): string {
  return parseRichText(value)
    .runs.filter(predicate)
    .map((run) => run.text)
    .join("");
}

function boldLetters(value: string): string {
  return lettersWith(value, (run) => Boolean(run.bold));
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 400, h: 300 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "left",
    textColor: "#111111",
    backgroundColor: "#fffdf5",
    opacity: 1,
    autoFitText: false,
    ...patch,
  };
}

function FontsTestProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <FontsContext.Provider
      value={{
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        baseOptions: [],
        options: [
          {
            id: "default",
            label: "기본 폰트",
            cssFamily: '"Nanum Gothic", sans-serif',
            sample: "가나다 Aa",
          },
          {
            id: "nanum-gothic",
            label: "나눔고딕",
            cssFamily: '"Nanum Gothic", sans-serif',
            sample: "나눔고딕 Aa",
          },
        ],
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      {children}
    </FontsContext.Provider>
  );
}
