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
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { PanelCommandSchema } from "../src/shared/panelBridgeSchemas";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { EditorPanel } from "../src/renderer/src/components/EditorPanel";
import { useBlockEditingActions } from "../src/renderer/src/hooks/useBlockEditingActions";
import { applyBackgroundOpacity } from "../src/renderer/src/hooks/useApplyBlockBackgroundOpacityAction";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import { adjustBlockFontSizeInChapter } from "../src/renderer/src/lib/blockFontSizeAdjustment";
import { resolveBlockTextLayout } from "../src/renderer/src/lib/overlayLayout";
import { useRemotePanelSession } from "../src/renderer/src/panels/useRemotePanelSession";

vi.mock("../src/renderer/src/components/FontSelect", () => ({
  FontSelect: () => <div data-testid="font-select" />,
}));

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const localStorageValues = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => localStorageValues.clear(),
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  },
});

afterEach(() => {
  cleanup();
  localStorageValues.clear();
});

describe("selected block font-size adjustment", () => {
  it("adjusts only the active manual-size block by one pixel", () => {
    const chapter = makeChapter([
      makeBlock({ id: "active", fontSizePx: 24, autoFitText: false }),
      makeBlock({ id: "also-selected", fontSizePx: 40, autoFitText: false }),
    ]);

    const next = adjustBlockFontSizeInChapter(chapter, "page-1", "active", 1);

    expect(next.pages[0]?.blocks[0]?.fontSizePx).toBe(25);
    expect(next.pages[0]?.blocks[1]?.fontSizePx).toBe(40);
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
    ).fontSizePx;

    const next = adjustBlockFontSizeInChapter(chapter, page.id, block.id, -1);
    const adjusted = next.pages[0]?.blocks[0];

    expect(adjusted?.autoFitText).toBe(false);
    expect(adjusted?.fontSizePx).toBe(
      Math.max(10, Math.min(160, resolved - 1)),
    );
    expect(adjusted?.fontSizePx).not.toBe(block.fontSizePx - 1);
  });

  it("clamps to 10..160 and skips empty bound edits", () => {
    const minimum = makeChapter([
      makeBlock({ autoFitText: false, fontSizePx: 10 }),
    ]);
    const maximum = makeChapter([
      makeBlock({ autoFitText: false, fontSizePx: 160 }),
    ]);

    expect(adjustBlockFontSizeInChapter(minimum, "page-1", "block-1", -1)).toBe(
      minimum,
    );
    expect(adjustBlockFontSizeInChapter(maximum, "page-1", "block-1", 1)).toBe(
      maximum,
    );
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
    const { result } = renderHook(() =>
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
    );

    act(() => {
      result.current.adjustSelectedBlockFontSize(1);
      result.current.adjustSelectedBlockFontSize(1);
    });

    expect(chapter.pages[0]?.blocks[0]?.fontSizePx).toBe(26);
    expect(updateCurrentChapter).toHaveBeenCalledTimes(2);
  });

  it("renders accessible minus/plus controls and delegates relative actions", () => {
    const onAdjustFontSize = vi.fn();
    render(
      <EditorPanel
        block={makeBlock({ autoFitText: false, fontSizePx: 24 })}
        disabled={false}
        onAdjustFontSize={onAdjustFontSize}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    act(() => screen.getByRole("button", { name: "글자 크기 줄이기" }).click());
    act(() => screen.getByRole("button", { name: "글자 크기 늘리기" }).click());

    expect(onAdjustFontSize.mock.calls).toEqual([[-1], [1]]);
  });

  it("exposes separate OCR and translation actions for the selected block", () => {
    const onOcrBlock = vi.fn();
    const onTranslateBlock = vi.fn();
    render(
      <EditorPanel
        block={makeBlock()}
        disabled={false}
        onAdjustFontSize={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOcrBlock={onOcrBlock}
        onTranslateBlock={onTranslateBlock}
        onUpdate={vi.fn()}
      />,
    );

    act(() => screen.getByRole("button", { name: "OCR" }).click());
    act(() => screen.getByRole("button", { name: "번역" }).click());

    expect(onOcrBlock).toHaveBeenCalledOnce();
    expect(onTranslateBlock).toHaveBeenCalledOnce();
  });

  it("requires source text before translating a selected block", () => {
    render(
      <EditorPanel
        block={makeBlock({ sourceText: "" })}
        disabled={false}
        onAdjustFontSize={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onOcrBlock={vi.fn()}
        onTranslateBlock={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "OCR" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "번역" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("edits line wrapping with user-facing labels", () => {
    const onUpdate = vi.fn();
    render(
      <EditorPanel
        block={makeBlock()}
        disabled={false}
        onAdjustFontSize={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    const select = screen.getByRole("combobox", { name: "줄바꿈 방식" });
    expect((select as HTMLSelectElement).value).toBe("break-all");
    expect(screen.getByRole("option", { name: "글자 단위" })).toBeTruthy();
    expect(
      screen.getByText("단어 중간이라도 글자 단위로 줄을 바꿉니다."),
    ).toBeTruthy();
    expect(screen.queryByText("break-word")).toBeNull();

    fireEvent.change(select, { target: { value: "break-word" } });
    expect(onUpdate).toHaveBeenCalledWith({ wordBreak: "break-word" });
  });

  it("shows the legacy vertical wrapping behavior", () => {
    render(
      <EditorPanel
        block={makeBlock({ renderDirection: "vertical" })}
        disabled={false}
        onAdjustFontSize={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(
      (
        screen.getByRole("combobox", {
          name: "줄바꿈 방식",
        }) as HTMLSelectElement
      ).value,
    ).toBe("break-word");
  });

  it("keeps text opacity in formatting and block background opacity in editor display", () => {
    const onUpdate = vi.fn();
    const onApplyBlockBackgroundOpacity = vi.fn();
    render(
      <EditorPanel
        block={makeBlock({ textOpacity: 0.8, opacity: 0.6 })}
        disabled={false}
        onApplyBlockBackgroundOpacity={onApplyBlockBackgroundOpacity}
        onAdjustFontSize={vi.fn()}
        onDelete={vi.fn()}
        onDuplicate={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    const textOpacity = screen.getByRole("slider", { name: "글자 투명도" });
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

    fireEvent.change(textOpacity, { target: { value: "0.4" } });
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
    const { result } = renderHook(() =>
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
    const { result } = renderHook(() =>
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
    { type: "ocrBlock" },
    { type: "translateBlock" },
  ])("requires a block id for $type commands", (command) => {
    expect(() => PanelCommandSchema.parse(command)).toThrow();
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
    const state = {
      areaTranslateAvailable: false,
      areaTranslateSelecting: false,
      disableChapterApply: false,
      editorDisabled: false,
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
    act(() => result.current?.onDeleteBlock());
    act(() => result.current?.onDuplicateBlock());
    act(() => result.current?.onOcrBlock());
    act(() => result.current?.onTranslateBlock());
    act(() => result.current?.onApplyBlockBackgroundOpacity("chapter"));

    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "adjustFontSize",
      blockId: block.id,
      adjustment: 1,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "updateBlock",
      blockId: block.id,
      patch: { translatedText: "수정" },
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
      type: "ocrBlock",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "translateBlock",
      blockId: block.id,
    });
    expect(sendPanelCommand).toHaveBeenCalledWith({
      type: "applyBlockBackgroundOpacity",
      scope: "chapter",
    });
  });
});

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
