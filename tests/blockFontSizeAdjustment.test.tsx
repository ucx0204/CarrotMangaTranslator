/* eslint-disable max-lines -- text-format UI regressions share the production editor fixture and interaction harness */
/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseCustomSelectOption,
  openCustomSelect,
} from "./testUtils/customSelect";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { BlockLibraryEntryV1 } from "../src/shared/blockLibrary";
import type { TranslationBlock } from "../src/shared/textTypes";
import { PanelCommandSchema } from "../src/shared/panelBridgeSchemas";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { EditorPanel } from "../src/renderer/src/components/EditorPanel";
import { useBlockEditingActions } from "../src/renderer/src/hooks/useBlockEditingActions";
import { applyBackgroundOpacity } from "../src/renderer/src/hooks/useApplyBlockBackgroundOpacityAction";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import {
  adjustBlockFontSizeInChapter,
  adjustBlocksFontSizeInChapter,
} from "../src/renderer/src/lib/blockFontSizeAdjustment";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import { useRemotePanelSession } from "../src/renderer/src/panels/useRemotePanelSession";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

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

describe("selected block font-size adjustment", () => {
  it("keeps text edits on the active block and applies format patches to the exact selection", () => {
    let chapter = makeChapter([
      makeBlock({ id: "active", translatedText: "첫째", bold: false }),
      makeBlock({ id: "also-selected", translatedText: "둘째", bold: false }),
      makeBlock({ id: "unselected", translatedText: "셋째", bold: false }),
    ]);
    const page = chapter.pages[0] as MangaPage;
    const active = page.blocks[0] as TranslationBlock;
    const updateCurrentChapter = vi.fn<UpdateCurrentChapter>(
      (_pageId, updater) => {
        chapter = updater(chapter);
      },
    );
    const { result } = renderHook(
      () =>
        useBlockEditingActions({
          currentChapter: chapter,
          jobActive: false,
          pushStatus: vi.fn(),
          selectedBlock: active,
          selectedBlockIds: ["active", "also-selected"],
          selectedPage: page,
          selectedPageEditLocked: false,
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
          updateCurrentChapter,
        }),
      { wrapper: FontsTestProvider },
    );

    act(() => result.current.updateSelectedBlock({ translatedText: "수정" }));
    expect(
      chapter.pages[0]?.blocks.map((block) => block.translatedText),
    ).toEqual(["수정", "둘째", "셋째"]);

    act(() => result.current.updateSelectedBlocks({ bold: true }));
    expect(chapter.pages[0]?.blocks.map((block) => block.bold)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("adjusts only the active manual-size block by half a pixel", () => {
    const chapter = makeChapter([
      makeBlock({ id: "active", fontSizePx: 24, autoFitText: false }),
      makeBlock({ id: "also-selected", fontSizePx: 40, autoFitText: false }),
    ]);

    const next = adjustBlockFontSizeInChapter(
      chapter,
      "page-1",
      "active",
      1,
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    expect(next.pages[0]?.blocks[0]?.fontSizePx).toBe(24.5);
    expect(next.pages[0]?.blocks[1]?.fontSizePx).toBe(40);
  });

  it("adjusts every selected block in one immutable chapter update", () => {
    const chapter = makeChapter([
      makeBlock({ id: "first", fontSizePx: 24, autoFitText: false }),
      makeBlock({ id: "second", fontSizePx: 40, autoFitText: false }),
      makeBlock({ id: "unselected", fontSizePx: 60, autoFitText: false }),
    ]);

    const next = adjustBlocksFontSizeInChapter(
      chapter,
      "page-1",
      ["second", "first", "first"],
      1,
      DEFAULT_BLOCK_FONT_CATALOG,
    );

    expect(next).not.toBe(chapter);
    expect(next.pages[0]?.blocks.map((block) => block.fontSizePx)).toEqual([
      24.5, 40.5, 60,
    ]);
  });

  it("uses the visually resolved auto-fit size at natural page scale", () => {
    const block = makeBlock({
      autoFitText: true,
      bbox: { x: 100, y: 100, w: 400, h: 400 },
      fontSizePx: 24,
      renderDirection: "vertical",
      translatedText: "가나다라",
    });
    const chapter = makeChapter([block]);
    const page = chapter.pages[0] as MangaPage;
    const naturalSize = { width: page.width, height: page.height };
    const resolved = resolveBlockTextLayout(
      block,
      block.translatedText,
      naturalSize,
      naturalSize,
      DEFAULT_BLOCK_FONT_CATALOG,
    ).fontSizePx;

    const next = adjustBlockFontSizeInChapter(
      chapter,
      page.id,
      block.id,
      -1,
      DEFAULT_BLOCK_FONT_CATALOG,
    );
    const adjusted = next.pages[0]?.blocks[0];

    expect(adjusted?.autoFitText).toBe(false);
    expect(adjusted?.fontSizePx).toBe(
      Math.max(1, Math.min(512, resolved - 0.5)),
    );
    expect(adjusted?.fontSizePx).not.toBe(block.fontSizePx - 0.5);
  });

  it("clamps to 1..512 and skips empty bound edits", () => {
    const minimum = makeChapter([
      makeBlock({ autoFitText: false, fontSizePx: 1 }),
    ]);
    const maximum = makeChapter([
      makeBlock({ autoFitText: false, fontSizePx: 512 }),
    ]);

    expect(
      adjustBlockFontSizeInChapter(
        minimum,
        "page-1",
        "block-1",
        -1,
        DEFAULT_BLOCK_FONT_CATALOG,
      ),
    ).toBe(minimum);
    expect(
      adjustBlockFontSizeInChapter(
        maximum,
        "page-1",
        "block-1",
        1,
        DEFAULT_BLOCK_FONT_CATALOG,
      ),
    ).toBe(maximum);
  });

  it("applies rapid actions to the latest chapter instead of stale props", () => {
    let chapter = makeChapter([
      makeBlock({ autoFitText: false, fontSizePx: 24 }),
    ]);
    const updateCurrentChapter = vi.fn(
      (
        _pageId: string,
        updater: (value: ChapterSnapshot) => ChapterSnapshot,
      ) => {
        chapter = updater(chapter);
      },
    );
    const page = chapter.pages[0] as MangaPage;
    const block = page.blocks[0] as TranslationBlock;
    const { result } = renderHook(
      () =>
        useBlockEditingActions({
          currentChapter: chapter,
          jobActive: false,
          pushStatus: vi.fn(),
          selectedBlock: block,
          selectedBlockIds: [block.id],
          selectedPage: page,
          selectedPageEditLocked: false,
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
          updateCurrentChapter,
        }),
      { wrapper: FontsTestProvider },
    );

    act(() => {
      result.current.adjustSelectedBlockFontSize(1);
      result.current.adjustSelectedBlockFontSize(1);
    });

    expect(chapter.pages[0]?.blocks[0]?.fontSizePx).toBe(25);
    expect(updateCurrentChapter).toHaveBeenCalledTimes(2);
  });

  it("removes a failed bubble fit and its render bounds in one history edit", () => {
    const fittedBlock = makeBlock({
      renderBbox: { x: 50, y: 60, w: 320, h: 420 },
      renderBboxSpace: "normalized_1000",
      bubbleLayout: makeBubbleLayout(),
    });
    let chapter = makeChapter([fittedBlock]);
    const page = chapter.pages[0] as MangaPage;
    const updateCurrentChapter = vi.fn<UpdateCurrentChapter>(
      (_pageId, updater) => {
        chapter = updater(chapter);
      },
    );
    const { result } = renderHook(
      () =>
        useBlockEditingActions({
          currentChapter: chapter,
          jobActive: false,
          pushStatus: vi.fn(),
          selectedBlock: fittedBlock,
          selectedBlockIds: [fittedBlock.id],
          selectedPage: page,
          selectedPageEditLocked: false,
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
          updateCurrentChapter,
        }),
      { wrapper: FontsTestProvider },
    );

    act(() => result.current.removeSelectedBlockBubbleLayout());

    const restored = chapter.pages[0]?.blocks[0];
    expect(restored?.bbox).toEqual(fittedBlock.bbox);
    expect(restored).not.toHaveProperty("bubbleLayout");
    expect(restored).not.toHaveProperty("renderBbox");
    expect(restored).not.toHaveProperty("renderBboxSpace");
    expect(updateCurrentChapter).toHaveBeenCalledOnce();
    expect(updateCurrentChapter.mock.calls[0]?.[2]).toEqual({
      label: "말풍선 맞춤 해제",
    });
  });

  it("shows an accessible remove action only for a bubble-fitted block", () => {
    const onRemoveBubbleLayout = vi.fn();
    const { rerender } = render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ bubbleLayout: makeBubbleLayout() })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onRemoveBubbleLayout={onRemoveBubbleLayout}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );

    const remove = screen.getByRole("button", {
      name: "말풍선 맞춤 해제",
    });
    expect(remove.hasAttribute("title")).toBe(false);
    expect(
      screen.getByRole("tab", { name: "텍스트" }).getAttribute("aria-selected"),
    ).toBe("true");
    selectEditorTab("서식");
    expect(
      screen.getByRole("button", { name: "말풍선 맞춤 해제" }),
    ).not.toBeNull();
    fireEvent.click(remove);
    expect(onRemoveBubbleLayout).toHaveBeenCalledOnce();

    rerender(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onRemoveBubbleLayout={onRemoveBubbleLayout}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "말풍선 맞춤 해제" }),
    ).toBeNull();
  });

  it("runs block-only erase and bubble-fit actions above the translation", () => {
    const onEraseOriginal = vi.fn();
    const onFitBubble = vi.fn();
    const view = render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onEraseOriginal={onEraseOriginal}
          onFitBubble={onFitBubble}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );

    const erase = screen.getByRole("button", { name: "원문 지우기" });
    const fit = screen.getByRole("button", { name: "말풍선 맞춤" });
    const actionRow = view.container.querySelector(".editor-text-actions");
    expect(
      actionRow?.nextElementSibling?.classList.contains(
        "rich-translation-editor",
      ),
    ).toBe(true);

    fireEvent.click(erase);
    fireEvent.click(fit);
    expect(onEraseOriginal).toHaveBeenCalledOnce();
    expect(onFitBubble).toHaveBeenCalledOnce();

    view.rerender(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onEraseOriginal={onEraseOriginal}
          onFitBubble={onFitBubble}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "원문 지우기",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "말풍선 맞춤",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps text and OCR visible and preserves drafts across tabs", () => {
    const onUpdate = vi.fn();
    const onUpdateFormat = vi.fn();
    const { container } = render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({
            sourceText: "OCR 첫 줄\nOCR 둘째 줄",
            translatedText: "처음 번역",
          })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
          onUpdateFormat={onUpdateFormat}
        />
      </FontsTestProvider>,
    );

    expect(
      screen.getByRole("tab", { name: "텍스트" }).getAttribute("aria-selected"),
    ).toBe("true");
    const translation = screen.getByRole("textbox", {
      name: "번역문",
    }) as HTMLDivElement;
    translation.textContent = "작성 중 번역";
    fireEvent.input(translation);
    expect(onUpdate).toHaveBeenCalledWith({ translatedText: "작성 중 번역" });
    expect(onUpdateFormat).not.toHaveBeenCalled();

    const source = screen.getByRole("textbox", {
      name: "OCR",
    }) as HTMLTextAreaElement;
    expect(source.value).toBe("OCR 첫 줄\nOCR 둘째 줄");
    expect(container.querySelector(".editor-source-disclosure")).toBeNull();
    expect(container.querySelector(".editor-source-field")).not.toBeNull();
    expect(container.querySelector(".markup-hint")).toBeNull();

    expect(
      screen.queryByRole("button", { name: "부분 강조 도움말" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "굵게 (**굵게**)" }),
    ).not.toBeNull();
    fireEvent.change(source, { target: { value: "수정한 OCR" } });
    expect(onUpdate).toHaveBeenCalledWith({ sourceText: "수정한 OCR" });
    expect(onUpdateFormat).not.toHaveBeenCalled();

    selectEditorTab("배치");
    fireEvent.change(screen.getByRole("slider", { name: "회전 슬라이더" }), {
      target: { value: "15" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ rotationDeg: 15 });
    expect(onUpdateFormat).not.toHaveBeenCalled();

    selectEditorTab("서식");
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 굵게" }));
    expect(onUpdateFormat).toHaveBeenCalledWith({ bold: true });
    selectEditorTab("텍스트");
    expect(screen.getByRole("textbox", { name: "번역문" }).textContent).toBe(
      "작성 중 번역",
    );
    expect(
      (screen.getByRole("textbox", { name: "OCR" }) as HTMLTextAreaElement)
        .value,
    ).toBe("수정한 OCR");
  });

  it("applies visible per-character formatting and can inspect or reset its code", async () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가나다라", fontSizePx: 12 })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "번역문" });
    const textNode = editor.querySelector("[data-rich-text-run]")?.firstChild;
    if (!textNode) throw new Error("Expected a visual editor text node");
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 3);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    const inlinePanel = screen.getByRole("region", { name: "글자별 서식" });
    expect(
      within(inlinePanel).getByRole("button", { name: "굵게 (**굵게**)" }),
    ).not.toBeNull();
    expect(
      within(inlinePanel).getByRole("button", {
        name: "기울임 (*기울임*)",
      }),
    ).not.toBeNull();
    const size = within(inlinePanel).getByRole("textbox", {
      name: "글자 크기",
    }) as HTMLInputElement;
    fireEvent.pointerDown(size);
    act(() => size.focus());
    act(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(
      Array.from(
        editor.querySelectorAll<HTMLElement>("[data-rich-text-selection]"),
      )
        .map((element) => element.textContent)
        .join(""),
    ).toBe("나다");
    fireEvent.change(size, { target: { value: "40" } });
    expect(document.activeElement).toBe(size);
    const opacity = within(inlinePanel).getByRole("textbox", {
      name: "글자 투명도",
    }) as HTMLInputElement;
    fireEvent.pointerDown(opacity);
    act(() => opacity.focus());
    fireEvent.change(opacity, { target: { value: "60" } });
    expect(document.activeElement).toBe(opacity);

    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({
        translatedText: "가[size=40][opacity=60]나다[/opacity][/size]라",
      }),
    );
    expect(editor.textContent).toBe("가나다라");
    expect(
      Array.from(
        editor.querySelectorAll<HTMLElement>("[data-rich-text-selection]"),
      )
        .map((element) => element.textContent)
        .join(""),
    ).toBe("나다");
    expect(
      editor.querySelectorAll<HTMLElement>("[data-rich-text-run]")[1]?.style
        .opacity,
    ).toBe("0.6");

    fireEvent.click(screen.getByRole("button", { name: "코드" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "번역문 서식 코드",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("가[size=40][opacity=60]나다[/opacity][/size]라");

    fireEvent.click(
      screen.getByRole("button", { name: "번역문 서식 전체 초기화" }),
    );
    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({ translatedText: "가나다라" }),
    );
  });

  it("edits the complete visual style set on a selected character range", () => {
    const onUpdate = vi.fn();
    const translatedText =
      "[underline][strike][emphasis][tcy][size=30][font=nanum-gothic][opacity=80][width=1.2][color=#112233][background=#fefefe][outline-color=#ffffff][outline-width=2][outer-outline-color=#000000][outer-outline-width=3][glow-color=#ff8800][glow-blur=6][glow-opacity=0.65]효과[/glow-opacity][/glow-blur][/glow-color][/outer-outline-width][/outer-outline-color][/outline-width][/outline-color][/background][/color][/width][/opacity][/font][/size][/tcy][/emphasis][/strike][/underline]";
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );

    const editor = screen.getByRole("textbox", { name: "번역문" });
    const textNode = Array.from(
      editor.querySelectorAll<HTMLElement>("[data-rich-text-run]"),
    ).find((run) => run.textContent === "효과")?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Expected a fully styled visual run");
    }
    const range = document.createRange();
    range.selectNodeContents(textNode);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    const panel = screen.getByRole("region", { name: "글자별 서식" });
    fireEvent.click(
      within(panel).getByRole("button", { name: "블록 전체 밑줄" }),
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: "블록 전체 취소선" }),
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: "블록 전체 강조점" }),
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: "세로쓰기 영문 묶음" }),
    );
    fireEvent.change(within(panel).getByRole("textbox", { name: "장평" }), {
      target: { value: "135" },
    });
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "글자색 HEX" }),
      { target: { value: "#334455" } },
    );
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "배경색 HEX" }),
      { target: { value: "#fff4cc" } },
    );

    fireEvent.click(within(panel).getByText("외곽선 · 광선"));
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "외곽선 HEX" }),
      { target: { value: "#ddeeff" } },
    );
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "바깥 외곽선 HEX" }),
      { target: { value: "#101820" } },
    );
    const outlineWidths = within(panel).getAllByRole("textbox", {
      name: "외곽선 굵기",
    });
    fireEvent.change(outlineWidths[0] as HTMLInputElement, {
      target: { value: "2.5" },
    });
    fireEvent.change(outlineWidths[1] as HTMLInputElement, {
      target: { value: "4" },
    });
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "광선 색상 HEX" }),
      { target: { value: "#ff4400" } },
    );
    fireEvent.change(within(panel).getByRole("textbox", { name: "퍼짐" }), {
      target: { value: "9" },
    });
    fireEvent.change(within(panel).getByRole("textbox", { name: "불투명도" }), {
      target: { value: "55" },
    });

    expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(12);
  });

  it("generates safe inline markup for every advanced control in code mode", () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({
            translatedText: "효과",
            outlineColor: "#ffffff",
            outlineWidthPx: 2,
            outerOutlineColor: "#111111",
            outerOutlineWidthPx: 3,
            textGlow: {
              enabled: true,
              color: "#ff8800",
              blurPx: 6,
              opacity: 0.65,
            },
          })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "코드" }));
    const code = screen.getByRole("textbox", {
      name: "번역문 서식 코드",
    }) as HTMLTextAreaElement;
    code.setSelectionRange(0, 2);
    fireEvent.select(code);
    const panel = screen.getByRole("region", { name: "글자별 서식" });

    for (const name of [
      "블록 전체 밑줄",
      "블록 전체 취소선",
      "블록 전체 강조점",
      "세로쓰기 영문 묶음",
    ]) {
      fireEvent.click(within(panel).getByRole("button", { name }));
    }
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "글자 크기" }),
      { target: { value: "36" } },
    );
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "글자 투명도" }),
      { target: { value: "70" } },
    );
    fireEvent.change(within(panel).getByRole("textbox", { name: "장평" }), {
      target: { value: "125" },
    });
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "글자색 HEX" }),
      { target: { value: "#123456" } },
    );
    fireEvent.click(within(panel).getByRole("checkbox", { name: "글자 배경" }));
    fireEvent.click(within(panel).getByText("외곽선 · 광선"));
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "외곽선 HEX" }),
      { target: { value: "#abcdef" } },
    );
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "바깥 외곽선 HEX" }),
      { target: { value: "#010203" } },
    );
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "광선 색상 HEX" }),
      { target: { value: "#ff5500" } },
    );

    const generated = onUpdate.mock.calls
      .map(([patch]) => (patch as Partial<TranslationBlock>).translatedText)
      .filter((value): value is string => typeof value === "string");
    expect(generated.some((value) => value.includes("[underline]"))).toBe(true);
    expect(generated.some((value) => value.includes("[width=1.25]"))).toBe(
      true,
    );
    expect(
      generated.some((value) => value.includes("[glow-color=#ff5500]")),
    ).toBe(true);
  });

  it("shows the actual character formatting at the visual caret", () => {
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({
            translatedText: "가[size=48][opacity=60]나다[/opacity][/size]라",
            fontSizePx: 12,
          })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "번역문" });
    const styledText = editor.querySelector<HTMLElement>(
      "[data-size-px='48']",
    )?.firstChild;
    if (!styledText) throw new Error("Expected an inline-sized text run");
    const range = document.createRange();
    range.setStart(styledText, 1);
    range.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    const inlinePanel = screen.getByRole("region", { name: "글자별 서식" });
    expect(
      (
        within(inlinePanel).getByRole("textbox", {
          name: "글자 크기",
        }) as HTMLInputElement
      ).value,
    ).toBe("48");
    expect(
      (
        within(inlinePanel).getByRole("textbox", {
          name: "글자 투명도",
        }) as HTMLInputElement
      ).value,
    ).toBe("60");
  });

  it("preserves text and formatting when returning from code to visual mode", () => {
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({
            translatedText: "가[size=48]나다[/size]라",
            fontSizePx: 12,
          })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );
    expect(screen.getByRole("textbox", { name: "번역문" }).textContent).toBe(
      "가나다라",
    );

    fireEvent.click(screen.getByRole("button", { name: "코드" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "번역문 서식 코드",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("가[size=48]나다[/size]라");
    fireEvent.click(screen.getByRole("button", { name: "편집" }));

    const visual = screen.getByRole("textbox", { name: "번역문" });
    expect(visual.textContent).toBe("가나다라");
    expect(
      visual.querySelector<HTMLElement>("[data-size-px='48']")?.textContent,
    ).toBe("나다");
  });

  it("uses a collapsed caret style only for text typed afterward", async () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가나다라", fontSizePx: 12 })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    const editor = screen.getByRole("textbox", {
      name: "번역문",
    }) as HTMLDivElement;
    const textNode = editor.querySelector("[data-rich-text-run]")?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Expected a visual editor text node");
    }
    const placeCaret = (offset: number, notify = true): void => {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.collapse(true);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      if (notify) document.dispatchEvent(new Event("selectionchange"));
    };
    act(() => placeCaret(1));

    const inlinePanel = screen.getByRole("region", { name: "글자별 서식" });
    const size = within(inlinePanel).getByRole("textbox", {
      name: "글자 크기",
    }) as HTMLInputElement;
    fireEvent.pointerDown(size);
    act(() => size.focus());
    fireEvent.change(size, { target: { value: "40" } });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(size.value).toBe("40");

    act(() => {
      editor.focus();
      placeCaret(1);
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "새",
          inputType: "insertText",
        }),
      );
      textNode.data = "가새나다라";
      placeCaret(2, false);
      fireEvent.input(editor, { data: "새", inputType: "insertText" });
      document.dispatchEvent(new Event("selectionchange"));
    });

    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({
        translatedText: "가[size=40]새[/size]나다라",
      }),
    );
  });

  it("waits for IME composition to finish before applying a typing style", async () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가나다라", fontSizePx: 12 })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    const editor = screen.getByRole("textbox", {
      name: "번역문",
    }) as HTMLDivElement;
    const textNode = editor.querySelector("[data-rich-text-run]")?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Expected a visual editor text node");
    }
    const placeCaret = (offset: number): void => {
      const range = document.createRange();
      range.setStart(textNode, offset);
      range.collapse(true);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    };
    act(() => {
      placeCaret(1);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const size = within(
      screen.getByRole("region", { name: "글자별 서식" }),
    ).getByRole("textbox", { name: "글자 크기" }) as HTMLInputElement;
    fireEvent.pointerDown(size);
    act(() => size.focus());
    fireEvent.change(size, { target: { value: "40" } });

    act(() => {
      editor.focus();
      placeCaret(1);
      document.dispatchEvent(new Event("selectionchange"));
    });
    fireEvent.compositionStart(editor);
    act(() => {
      textNode.data = "가한나다라";
      placeCaret(2);
      fireEvent.input(editor, {
        data: "한",
        inputType: "insertCompositionText",
        isComposing: true,
      });
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ translatedText: "가한나다라" });

    fireEvent.compositionEnd(editor, { data: "한" });
    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({
        translatedText: "가[size=40]한[/size]나다라",
      }),
    );
  });

  it("closes the character-font menu immediately after choosing a font", () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가나다라" })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "번역문" });
    const textNode = editor.querySelector("[data-rich-text-run]")?.firstChild;
    if (!textNode) throw new Error("Expected a visual editor text node");
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    const inlinePanel = screen.getByRole("region", { name: "글자별 서식" });
    // The font picker is now ui/Select, so its trigger is a combobox.
    const fontTrigger = within(inlinePanel).getByRole("combobox", {
      name: "글자 폰트",
    });
    fireEvent.click(fontTrigger);
    expect(screen.getByRole("listbox")).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /나눔고딕/ }));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fontTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("inserts a special character at the saved visual caret", async () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가나" })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "번역문" });
    const textNode = editor.querySelector("[data-rich-text-run]")?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error("Expected a visual editor text node");
    }
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.collapse(true);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    fireEvent.click(screen.getByRole("button", { name: "기호" }));
    expect(screen.getByTitle("〜 입력")).toBeTruthy();
    fireEvent.click(screen.getByTitle("!? 입력"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({
        translatedText: "가[tcy]!?[/tcy]나",
      }),
    );
    expect(screen.queryByRole("group", { name: "기호" })).toBeNull();
    expect(document.activeElement).toBe(editor);

    const combinedTextNode = editor.querySelector<HTMLElement>(
      '[data-vertical-combine="true"]',
    )?.firstChild;
    if (!(combinedTextNode instanceof Text)) {
      throw new Error("Expected a combined punctuation text node");
    }
    act(() => {
      const afterCombined = document.createRange();
      afterCombined.setStart(combinedTextNode, combinedTextNode.length);
      afterCombined.collapse(true);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(afterCombined);
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          data: "새",
          inputType: "insertText",
        }),
      );
      combinedTextNode.data = `${combinedTextNode.data}새`;
      afterCombined.setStart(combinedTextNode, combinedTextNode.length);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(afterCombined);
      fireEvent.input(editor, { data: "새", inputType: "insertText" });
    });

    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({
        translatedText: "가[tcy]!?[/tcy]새나",
      }),
    );
  });

  it("inserts a special character at the saved code selection", async () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가나다" })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "코드" }));
    const code = screen.getByRole("textbox", {
      name: "번역문 서식 코드",
    }) as HTMLTextAreaElement;
    code.setSelectionRange(1, 2);
    fireEvent.select(code);

    fireEvent.click(screen.getByRole("button", { name: "기호" }));
    fireEvent.click(screen.getByTitle("♥ 입력"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({ translatedText: "가♥다" }),
    );
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(code.selectionStart).toBe(2);
    expect(code.selectionEnd).toBe(2);
  });

  it("marks a combined punctuation option only when inserted from the palette", async () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ translatedText: "가!?나" })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "코드" }));
    const code = screen.getByRole("textbox", {
      name: "번역문 서식 코드",
    }) as HTMLTextAreaElement;
    expect(code.value).toBe("가!?나");
    code.setSelectionRange(1, 3);
    fireEvent.select(code);

    fireEvent.click(screen.getByRole("button", { name: "기호" }));
    fireEvent.click(screen.getByTitle("!? 입력"));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenLastCalledWith({
        translatedText: "가[tcy]!?[/tcy]나",
      }),
    );
  });

  it("supports tab keyboard navigation and remembers the selected tab", () => {
    const props = {
      block: makeBlock(),
      disabled: false,
      onAdjustFontSize: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onUpdate: vi.fn(),
    };
    const view = render(
      <FontsTestProvider>
        <EditorPanel {...props} />
      </FontsTestProvider>,
    );
    const textTab = screen.getByRole("tab", { name: "텍스트" });

    fireEvent.keyDown(textTab, { key: "ArrowRight" });
    const layoutTab = screen.getByRole("tab", { name: "배치" });
    expect(layoutTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(layoutTab);

    fireEvent.keyDown(layoutTab, { key: "End" });
    expect(
      screen.getByRole("tab", { name: "서식" }).getAttribute("aria-selected"),
    ).toBe("true");
    view.unmount();
    render(
      <FontsTestProvider>
        <EditorPanel {...props} />
      </FontsTestProvider>,
    );
    expect(
      screen.getByRole("tab", { name: "서식" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("returns to the text tab when a new-block request token changes", () => {
    const props = {
      block: makeBlock(),
      disabled: false,
      onAdjustFontSize: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onUpdate: vi.fn(),
    };
    const view = render(
      <FontsTestProvider>
        <EditorPanel {...props} editorTextTabRequestToken={0} />
      </FontsTestProvider>,
    );
    selectEditorTab("서식");

    view.rerender(
      <FontsTestProvider>
        <EditorPanel {...props} editorTextTabRequestToken={1} />
      </FontsTestProvider>,
    );

    expect(
      screen.getByRole("tab", { name: "텍스트" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens a newly mounted blank manual block on the text tab", () => {
    const props = {
      disabled: false,
      onAdjustFontSize: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onUpdate: vi.fn(),
    };
    const previous = render(
      <FontsTestProvider>
        <EditorPanel {...props} block={makeBlock()} />
      </FontsTestProvider>,
    );
    selectEditorTab("서식");
    previous.unmount();

    render(
      <FontsTestProvider>
        <EditorPanel
          {...props}
          block={makeBlock({ sourceText: "", translatedText: "" })}
          editorTextTabRequestToken={1}
        />
      </FontsTestProvider>,
    );

    expect(
      screen.getByRole("tab", { name: "텍스트" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps the editor header outside the scrolling tab body", () => {
    const view = render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );

    const panel = view.container.querySelector(".editor-panel.has-block");
    const header = panel?.querySelector(":scope > .editor-panel-sticky");
    const body = panel?.querySelector(":scope > .editor-panel-body");

    expect(panel).not.toBeNull();
    expect(header).not.toBeNull();
    expect(body).not.toBeNull();
    expect(header?.contains(screen.getByRole("tab", { name: "텍스트" }))).toBe(
      true,
    );
    expect(
      body?.contains(screen.getByRole("tabpanel", { name: "텍스트" })),
    ).toBe(true);
  });

  it("keeps the applied preset visible until direct formatting overrides it", () => {
    const onApplyStylePreset = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled={false}
          stylePresets={[
            {
              id: "style-preset:dialogue",
              name: "기본 대사",
              pinned: true,
              missingFont: false,
            },
          ]}
          onAdjustFontSize={vi.fn()}
          onApplyStylePreset={onApplyStylePreset}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    const presetTrigger = screen.getByRole("button", {
      name: "프리셋 선택",
    });
    fireEvent.click(presetTrigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "기본 대사" }));

    expect(onApplyStylePreset).toHaveBeenCalledWith("style-preset:dialogue");
    expect(presetTrigger.textContent).toContain("기본 대사");

    fireEvent.click(screen.getByRole("button", { name: "블록 전체 굵게" }));
    expect(presetTrigger.textContent).toContain("프리셋 선택");
  });

  it("exposes every whole-block character decoration as a direct format action", () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 기울임" }));
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 밑줄" }));
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 취소선" }));
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 강조점" }));

    expect(onUpdate).toHaveBeenCalledWith({ italic: true });
    expect(onUpdate).toHaveBeenCalledWith({ underline: true });
    expect(onUpdate).toHaveBeenCalledWith({ strikethrough: true });
    expect(onUpdate).toHaveBeenCalledWith({ emphasisMark: true });
  });

  it("reveals layout for a newly entered transform mode without trapping tabs", () => {
    const props = {
      block: makeBlock(),
      disabled: false,
      onAdjustFontSize: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onUpdate: vi.fn(),
    };
    const view = render(
      <FontsTestProvider>
        <EditorPanel {...props} transformMode="select" />
      </FontsTestProvider>,
    );

    view.rerender(
      <FontsTestProvider>
        <EditorPanel {...props} transformMode="perspective" />
      </FontsTestProvider>,
    );
    expect(
      screen.getByRole("tab", { name: "배치" }).getAttribute("aria-selected"),
    ).toBe("true");

    selectEditorTab("텍스트");
    view.rerender(
      <FontsTestProvider>
        <EditorPanel {...props} transformMode="curve" />
      </FontsTestProvider>,
    );
    expect(
      screen.getByRole("tab", { name: "텍스트" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps external header actions and moves block actions into overflow", () => {
    const onDelete = vi.fn();
    const onDuplicate = vi.fn();
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ inpaintExcluded: true })}
          disabled={false}
          headerActions={<button type="button">패널 분리</button>}
          onAdjustFontSize={vi.fn()}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );

    expect(screen.getByRole("button", { name: "패널 분리" })).not.toBeNull();
    expect(screen.getByText("자동 지우기에서 제외")).not.toBeNull();
    openBlockMenu();
    const exclusion = screen.getByRole("menuitemcheckbox", {
      name: "자동 지우기에서 제외",
    });
    expect(exclusion.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(exclusion);
    expect(onUpdate).toHaveBeenCalledWith({ inpaintExcluded: false });

    openBlockMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "복제" }));
    expect(onDuplicate).toHaveBeenCalledOnce();
    openBlockMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "삭제" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("renders accessible minus/plus controls and delegates relative actions", () => {
    const onAdjustFontSize = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ autoFitText: false, fontSizePx: 24 })}
          disabled={false}
          onAdjustFontSize={onAdjustFontSize}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    act(() => screen.getByRole("button", { name: "글자 크기 줄이기" }).click());
    act(() => screen.getByRole("button", { name: "글자 크기 늘리기" }).click());

    expect(onAdjustFontSize.mock.calls).toEqual([[-1], [1]]);
  });

  it("accepts a direct editor size and opens the format batch dialog", () => {
    const onApplyFormat = vi.fn();
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ autoFitText: false, fontSizePx: 24 })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onApplyFormat={onApplyFormat}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
          selectedBlockCount={2}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    const sizeInput = screen.getByRole("spinbutton", {
      name: "글자 크기 값",
    });
    fireEvent.change(sizeInput, { target: { value: "128.5" } });
    fireEvent.keyDown(sizeInput, { key: "Enter" });
    expect(onUpdate).toHaveBeenLastCalledWith({
      fontSizePx: 128.5,
      autoFitText: false,
    });

    const formatGroup = screen
      .getByRole("heading", { name: "서식" })
      .closest(".editor-group");
    fireEvent.click(
      within(formatGroup as HTMLElement).getByRole("button", {
        name: "일괄 적용",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "서식 일괄 적용" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(
      screen.queryByRole("heading", { name: "서식 일괄 적용" }),
    ).toBeNull();
    expect(onApplyFormat).not.toHaveBeenCalled();
  });

  it("edits line wrapping with user-facing labels", () => {
    const onUpdate = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock()}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    const select = screen.getByRole("combobox", { name: "줄바꿈 방식" });
    expect((select as HTMLButtonElement).value).toBe("break-all");
    expect(
      screen.queryByText("단어 중간이라도 글자 단위로 줄을 바꿉니다."),
    ).toBeNull();
    openCustomSelect("줄바꿈 방식");
    expect(screen.getByRole("option", { name: "글자 단위" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual([
      "표준",
      "표준+넘침 방지",
      "글자 단위",
      "단어 단위",
      "단어 단위+넘침 방지",
    ]);
    expect(
      screen.queryByText("단어 중간이라도 글자 단위로 줄을 바꿉니다."),
    ).toBeNull();
    expect(screen.queryByText("break-word")).toBeNull();

    chooseCustomSelectOption("줄바꿈 방식", "표준+넘침 방지");
    expect(onUpdate).toHaveBeenCalledWith({ wordBreak: "break-word" });

    chooseCustomSelectOption("줄바꿈 방식", "단어 단위+넘침 방지");
    expect(onUpdate).toHaveBeenLastCalledWith({
      wordBreak: "keep-all-overflow",
    });
  });

  it("shows the legacy vertical wrapping behavior", () => {
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ renderDirection: "vertical" })}
          disabled={false}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={vi.fn()}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    expect(
      (
        screen.getByRole("combobox", {
          name: "줄바꿈 방식",
        }) as HTMLButtonElement
      ).value,
    ).toBe("break-word");
  });

  it("keeps text opacity in formatting and block background opacity in editor display", () => {
    const onUpdate = vi.fn();
    const onApplyBlockBackgroundOpacity = vi.fn();
    render(
      <FontsTestProvider>
        <EditorPanel
          block={makeBlock({ textOpacity: 0.8, opacity: 0.6 })}
          disabled={false}
          onApplyBlockBackgroundOpacity={onApplyBlockBackgroundOpacity}
          onAdjustFontSize={vi.fn()}
          onDelete={vi.fn()}
          onDuplicate={vi.fn()}
          onUpdate={onUpdate}
        />
      </FontsTestProvider>,
    );

    selectEditorTab("서식");
    const textOpacity = screen.getByRole("spinbutton", {
      name: "글자 투명도",
    }) as HTMLInputElement;
    const backgroundOpacity = screen.getByRole("slider", {
      name: "블록 배경 투명도",
    });
    expect(textOpacity.closest(".editor-group")?.textContent).toContain("서식");
    expect(backgroundOpacity.closest(".editor-group")?.textContent).toContain(
      "편집 표시",
    );
    expect(
      screen.queryByText(
        "편집 중 블록 위치를 보여 주는 배경입니다. PNG 출력에는 포함되지 않습니다.",
      ),
    ).toBeNull();

    expect([textOpacity.min, textOpacity.max, textOpacity.step]).toEqual([
      "0",
      "100",
      "1",
    ]);
    expect(textOpacity.valueAsNumber).toBe(80);
    fireEvent.change(textOpacity, { target: { value: "40" } });
    fireEvent.keyDown(textOpacity, { key: "Enter" });
    fireEvent.change(backgroundOpacity, { target: { value: "0.2" } });
    expect(onUpdate).toHaveBeenNthCalledWith(1, { textOpacity: 0.4 });
    expect(onUpdate).toHaveBeenNthCalledWith(2, { opacity: 0.2 });

    const displayGroup = backgroundOpacity.closest(".editor-group");
    expect(displayGroup).not.toBeNull();
    fireEvent.click(
      within(displayGroup as HTMLElement).getByRole("button", {
        name: "일괄 적용",
      }),
    );
    expect(onApplyBlockBackgroundOpacity).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "블록 배경 일괄 적용" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    fireEvent.click(
      within(displayGroup as HTMLElement).getByRole("button", {
        name: "일괄 적용",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "이 화 전체" }));
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(onApplyBlockBackgroundOpacity.mock.calls).toEqual([
      ["page"],
      ["chapter"],
    ]);
  });

  it("copies only editor background opacity to the requested pages", () => {
    const chapter = makeChapter([
      makeBlock({ id: "source", opacity: 0.25, textOpacity: 0.4 }),
      makeBlock({ id: "peer", opacity: 0.9, textOpacity: 0.8 }),
    ]);
    const secondPage = {
      ...(chapter.pages[0] as MangaPage),
      id: "page-2",
      name: "2.png",
      blocks: [makeBlock({ id: "other", opacity: 0.7, textOpacity: 0.6 })],
    };
    const withSecondPage = {
      ...chapter,
      pageOrder: ["page-1", "page-2"],
      pages: [...chapter.pages, secondPage],
    };

    const pageOnly = applyBackgroundOpacity(
      withSecondPage,
      new Set(["page-1"]),
      0.25,
    );
    expect(pageOnly.pages[0]?.blocks.map((block) => block.opacity)).toEqual([
      0.25, 0.25,
    ]);
    expect(pageOnly.pages[1]?.blocks[0]?.opacity).toBe(0.7);
    expect(pageOnly.pages[0]?.blocks.map((block) => block.textOpacity)).toEqual(
      [0.4, 0.8],
    );

    const chapterWide = applyBackgroundOpacity(
      withSecondPage,
      new Set(["page-1", "page-2"]),
      0.25,
    );
    expect(chapterWide.pages[1]?.blocks[0]?.opacity).toBe(0.25);
    expect(chapterWide.pages[1]?.blocks[0]?.textOpacity).toBe(0.6);
    expect(
      applyBackgroundOpacity(chapterWide, new Set(["page-1", "page-2"]), 0.25),
    ).toBe(chapterWide);
  });

  it("skips history metadata and status when background opacity is unchanged", () => {
    const originalChapter = makeChapter([
      makeBlock({ id: "source", opacity: 0.25 }),
      makeBlock({ id: "peer", opacity: 0.25 }),
    ]);
    let latestChapter = originalChapter;
    const pushStatus = vi.fn();
    const updateCurrentChapter = vi.fn(
      (...args: Parameters<UpdateCurrentChapter>) => {
        latestChapter = args[1](latestChapter);
      },
    );
    const selectedPage = originalChapter.pages[0] as MangaPage;
    const selectedBlock = selectedPage.blocks[0] as TranslationBlock;
    const { result } = renderHook(
      () =>
        useBlockEditingActions({
          currentChapter: originalChapter,
          jobActive: false,
          pushStatus,
          selectedBlock,
          selectedBlockIds: [selectedBlock.id],
          selectedPage,
          selectedPageEditLocked: false,
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
          updateCurrentChapter,
        }),
      { wrapper: FontsTestProvider },
    );

    act(() => result.current.applyBlockBackgroundOpacityToScope("page"));

    expect(latestChapter).toBe(originalChapter);
    expect(updateCurrentChapter.mock.calls[0]?.[2]?.dirtyPageIds).toEqual([]);
    expect(pushStatus).not.toHaveBeenCalled();
  });

  it("marks only pages whose background opacity actually changed", () => {
    const firstChapter = makeChapter([
      makeBlock({ id: "source", opacity: 0.25 }),
    ]);
    const secondPage: MangaPage = {
      ...(firstChapter.pages[0] as MangaPage),
      id: "page-2",
      name: "2.png",
      blocks: [makeBlock({ id: "other", opacity: 0.7 })],
    };
    const originalChapter: ChapterSnapshot = {
      ...firstChapter,
      pageOrder: ["page-1", "page-2"],
      pages: [...firstChapter.pages, secondPage],
    };
    let latestChapter = originalChapter;
    const pushStatus = vi.fn();
    const updateCurrentChapter = vi.fn(
      (...args: Parameters<UpdateCurrentChapter>) => {
        latestChapter = args[1](latestChapter);
      },
    );
    const selectedPage = originalChapter.pages[0] as MangaPage;
    const selectedBlock = selectedPage.blocks[0] as TranslationBlock;
    const { result } = renderHook(
      () =>
        useBlockEditingActions({
          currentChapter: originalChapter,
          jobActive: false,
          pushStatus,
          selectedBlock,
          selectedBlockIds: [selectedBlock.id],
          selectedPage,
          selectedPageEditLocked: false,
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
          updateCurrentChapter,
        }),
      { wrapper: FontsTestProvider },
    );

    act(() => result.current.applyBlockBackgroundOpacityToScope("chapter"));

    expect(latestChapter.pages[0]).toBe(originalChapter.pages[0]);
    expect(latestChapter.pages[1]?.blocks[0]?.opacity).toBe(0.25);
    expect(updateCurrentChapter.mock.calls[0]?.[2]?.dirtyPageIds).toEqual([
      "page-2",
    ]);
    expect(pushStatus).toHaveBeenCalledOnce();
  });
});

describe("font-size panel bridge", () => {
  it("validates only one-pixel relative commands", () => {
    expect(
      PanelCommandSchema.parse({
        type: "adjustFontSize",
        blockId: "block-1",
        adjustment: -1,
      }),
    ).toEqual({
      type: "adjustFontSize",
      blockId: "block-1",
      adjustment: -1,
    });
    expect(() =>
      PanelCommandSchema.parse({
        type: "adjustFontSize",
        blockId: "block-1",
        adjustment: 0,
      }),
    ).toThrow();
  });

  it.each([
    { type: "updateBlock", patch: { translatedText: "수정" } },
    { type: "adjustFontSize", adjustment: 1 },
    { type: "deleteBlock" },
    { type: "duplicateBlock" },
    { type: "eraseBlockOriginal" },
    { type: "fitBlockBubble" },
    { type: "removeBubbleLayout" },
  ])("requires a block id for $type commands", (command) => {
    expect(() => PanelCommandSchema.parse(command)).toThrow();
  });

  it("requires a selection key for multi-block style preset application", () => {
    expect(() =>
      PanelCommandSchema.parse({
        type: "applyStylePreset",
        presetId: "style-preset:dialogue",
      }),
    ).toThrow();
  });

  it("accepts page/chapter background opacity commands but rejects selection", () => {
    expect(
      PanelCommandSchema.parse({
        type: "applyBlockBackgroundOpacity",
        scope: "page",
      }),
    ).toEqual({ type: "applyBlockBackgroundOpacity", scope: "page" });
    expect(() =>
      PanelCommandSchema.parse({
        type: "applyBlockBackgroundOpacity",
        scope: "selection",
      }),
    ).toThrow();
  });

  it("relays the relative action from a remote editor panel", async () => {
    const sendPanelCommand = vi.fn().mockResolvedValue({ sent: true });
    const block = makeBlock({ autoFitText: false, fontSizePx: 24 });
    const presetInput = {
      name: "대사",
      pinned: false,
      groupIds: ["font" as const],
    };
    const libraryEntry: BlockLibraryEntryV1 = {
      schemaVersion: 1,
      id: "library-entry",
      name: "효과음",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      lastUsedAt: "2026-08-31T00:00:00.000Z",
      block: {
        sourceText: "ドン",
        translatedText: "쾅",
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 48,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 1,
        size: { w: 240, h: 180 },
      },
    };
    const state = {
      areaTranslateAvailable: false,
      areaTranslateSelecting: false,
      blockStylePresets: [
        {
          id: "style-preset:dialogue",
          name: "대사",
          pinned: true,
          missingFont: false,
        },
      ],
      disableChapterApply: false,
      editorDisabled: false,
      editorTextTabRequestToken: 0,
      formatSelection: { common: {}, mixedFields: [] },
      selectionKey: JSON.stringify([block.id]),
      selectedBlock: block,
      selectedBlockCount: 1,
      selectedPageSize: { width: 1200, height: 1600 },
      transformMode: "select" as const,
    };
    Object.defineProperty(window, "mangaApi", {
      configurable: true,
      value: createTestMangaGatewayStub({
        getPanelState: async () => state,
        onPanelState: () => vi.fn(),
        sendPanelCommand,
      }),
    });

    const { result } = renderHook(() => useRemotePanelSession());
    await waitFor(() => expect(result.current).not.toBeNull());
    act(() => result.current?.onAdjustFontSize(1));
    act(() => result.current?.onUpdateBlock({ translatedText: "수정" }));
    act(() => result.current?.onUpdateFormat({ textColor: "#123456" }));
    act(() => result.current?.onDeleteBlock());
    act(() => result.current?.onDuplicateBlock());
    act(() => result.current?.onEraseBlockOriginal());
    act(() => result.current?.onFitBlockBubble());
    act(() => result.current?.onRemoveBubbleLayout());
    act(() => result.current?.onApplyStylePreset("style-preset:dialogue"));
    act(() => result.current?.onApplyFormat("page", ["font"]));
    act(() => result.current?.onApplyBlockBackgroundOpacity("chapter"));
    act(() => result.current?.onInsertBlockLibraryEntry(libraryEntry));
    act(() => result.current?.onOpenBlockLibrary());
    act(() => result.current?.onOpenStylePresetManager());
    act(() => result.current?.onOpenFontManager());
    act(() => result.current?.onSelectTransformMode("curve"));
    act(() => result.current?.onStartAreaTranslate());
    await act(async () => {
      expect(await result.current?.onCreateStylePreset(presetInput)).toBe(true);
      expect(
        await result.current?.onOverwriteStylePreset("style-preset:dialogue"),
      ).toBe(true);
      expect(
        await result.current?.onRenameStylePreset(
          "style-preset:dialogue",
          "말풍선",
        ),
      ).toBe(true);
      expect(
        await result.current?.onDeleteStylePreset("style-preset:dialogue"),
      ).toBe(true);
    });

    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "adjustSelectionFontSize",
      selectionKey: state.selectionKey,
      adjustment: 1,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "updateBlock",
      blockId: block.id,
      patch: { translatedText: "수정" },
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "updateSelectionFormat",
      selectionKey: state.selectionKey,
      patch: { textColor: "#123456" },
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "applyStylePreset",
      selectionKey: state.selectionKey,
      presetId: "style-preset:dialogue",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "applyFormat",
      scope: "page",
      groupIds: ["font"],
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "deleteBlock",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "duplicateBlock",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "eraseBlockOriginal",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "fitBlockBubble",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "removeBubbleLayout",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "applyBlockBackgroundOpacity",
      scope: "chapter",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "insertBlockLibraryEntry",
      entry: libraryEntry,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "openBlockLibrary",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "openStylePresetManager",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "openFontManager",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "selectTransformMode",
      mode: "curve",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "startAreaTranslate",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "createStylePreset",
      selectionKey: state.selectionKey,
      input: presetInput,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "overwriteStylePreset",
      selectionKey: state.selectionKey,
      presetId: "style-preset:dialogue",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "renameStylePreset",
      presetId: "style-preset:dialogue",
      name: "말풍선",
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "deleteStylePreset",
      presetId: "style-preset:dialogue",
    });
  });

  it("does not dispatch block-bound remote actions without a selection", async () => {
    const sendPanelCommand = vi.fn().mockResolvedValue({ sent: true });
    const state = {
      areaTranslateAvailable: false,
      areaTranslateSelecting: false,
      blockStylePresets: [],
      disableChapterApply: false,
      editorDisabled: false,
      editorTextTabRequestToken: 0,
      formatSelection: { common: {}, mixedFields: [] },
      selectionKey: "[]",
      selectedBlock: null,
      selectedBlockCount: 0,
      selectedPageSize: { width: 1200, height: 1600 },
      transformMode: "select" as const,
    };
    Object.defineProperty(window, "mangaApi", {
      configurable: true,
      value: createTestMangaGatewayStub({
        getPanelState: async () => state,
        onPanelState: () => vi.fn(),
        sendPanelCommand,
      }),
    });

    const { result } = renderHook(() => useRemotePanelSession());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.canCreateStylePreset).toBe(false);
    await act(async () => {
      expect(
        await result.current?.onCreateStylePreset({
          name: "선택 없음",
          pinned: false,
          groupIds: ["font"],
        }),
      ).toBe(false);
      expect(
        await result.current?.onOverwriteStylePreset("style-preset:dialogue"),
      ).toBe(false);
    });
    act(() => {
      result.current?.onAdjustFontSize(1);
      result.current?.onUpdateBlock({ translatedText: "무시" });
      result.current?.onUpdateFormat({ bold: true });
      result.current?.onDeleteBlock();
      result.current?.onDuplicateBlock();
      result.current?.onEraseBlockOriginal();
      result.current?.onFitBlockBubble();
      result.current?.onRemoveBubbleLayout();
      result.current?.onApplyStylePreset("style-preset:dialogue");
    });

    expect(sendPanelCommand).not.toHaveBeenCalled();
  });
});

function selectEditorTab(name: "텍스트" | "배치" | "서식"): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function openBlockMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "블록 작업 더 보기" }));
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#fffdf5",
    opacity: 1,
    autoFitText: false,
    ...patch,
  };
}

function makeBubbleLayout(): NonNullable<TranslationBlock["bubbleLayout"]> {
  return {
    version: 1,
    direction: "horizontal",
    confidence: 0.9,
    origin: "manual",
    insetRatio: 0.04,
    regions: [
      {
        spans: [
          {
            blockStart: 0,
            blockEnd: 1,
            inlineStart: 0,
            inlineEnd: 1,
          },
        ],
      },
    ],
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

function makeChapter(blocks: TranslationBlock[]): ChapterSnapshot {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "테스트",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1"],
    pages: [
      {
        id: "page-1",
        name: "1.png",
        imagePath: "1.png",
        dataUrl: "data:image/png;base64,",
        width: 1000,
        height: 1000,
        blocks,
        analysisStatus: "completed",
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
