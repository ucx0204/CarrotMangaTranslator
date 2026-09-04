/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { EditorPanelContainer } from "../src/renderer/src/panels/EditorPanelContainer";
import {
  PanelSessionContext,
  type PanelSessionValue,
} from "../src/renderer/src/panels/panelSession";

vi.stubGlobal(
  "ResizeObserver",
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

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
          actualBoundingBoxLeft: fontSize * 0.5,
          actualBoundingBoxRight: fontSize * 0.5,
        };
      },
    }),
  });
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

afterEach(cleanup);

describe("detached editor block-library ownership", () => {
  it("delegates opening to the main session without mounting a local modal", () => {
    const onOpenBlockLibrary = vi.fn();
    render(
      <FontsContext.Provider value={fontsContext}>
        <PanelSessionContext.Provider
          value={makePanelSession({ onOpenBlockLibrary })}
        >
          <EditorPanelContainer />
        </PanelSessionContext.Provider>
      </FontsContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "블록 라이브러리 열기" }),
    );

    expect(onOpenBlockLibrary).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps text and layout edits active-block-only while routing format edits to the selection", () => {
    const onUpdateBlock = vi.fn();
    const onUpdateFormat = vi.fn();
    render(
      <FontsContext.Provider value={fontsContext}>
        <PanelSessionContext.Provider
          value={makePanelSession({
            onUpdateBlock,
            onUpdateFormat,
            selectedBlock: makeBlock(),
            selectedBlockCount: 2,
          })}
        >
          <EditorPanelContainer />
        </PanelSessionContext.Provider>
      </FontsContext.Provider>,
    );

    expect(
      screen.getByRole("tab", { name: "서식" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "텍스트" }));
    const translation = screen.getByRole("textbox", {
      name: "번역문",
    }) as HTMLDivElement;
    translation.textContent = "분리 창 번역";
    fireEvent.input(translation);
    expect(onUpdateBlock).toHaveBeenLastCalledWith({
      translatedText: "분리 창 번역",
    });
    expect(onUpdateFormat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "배치" }));
    fireEvent.change(screen.getByRole("slider", { name: "회전 슬라이더" }), {
      target: { value: "12" },
    });
    expect(onUpdateBlock).toHaveBeenLastCalledWith({ rotationDeg: 12 });
    expect(onUpdateFormat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "서식" }));
    fireEvent.click(screen.getByRole("button", { name: "블록 전체 굵게" }));
    expect(onUpdateFormat).toHaveBeenLastCalledWith({ bold: true });
  });
});

const fontsContext: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

function makeBlock(): TranslationBlock {
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
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: false,
  };
}

function makePanelSession(
  overrides: Partial<PanelSessionValue> = {},
): PanelSessionValue {
  return {
    areaTranslateAvailable: false,
    areaTranslateSelecting: false,
    blockStylePresets: [],
    canCreateStylePreset: false,
    disableChapterApply: false,
    editorDisabled: false,
    editorFloating: false,
    editorPoppedOut: false,
    editorTextTabRequestToken: 0,
    formatSelection: { common: {}, mixedFields: [] },
    selectionKey: "[]",
    onAdjustFontSize: () => undefined,
    onApplyBlockBackgroundOpacity: () => undefined,
    onApplyFormat: () => undefined,
    onApplyStylePreset: () => undefined,
    onBackToPageBlocks: () => undefined,
    onCreateStylePreset: async () => false,
    onDeleteBlock: () => undefined,
    onDeleteStylePreset: async () => false,
    onDockEditorWindow: () => undefined,
    onDuplicateBlock: () => undefined,
    onEraseBlockOriginal: () => undefined,
    onFitBlockBubble: () => undefined,
    onInsertBlockLibraryEntry: () => undefined,
    onOpenBlockLibrary: () => undefined,
    onOpenFontManager: () => undefined,
    onOpenStylePresetManager: () => undefined,
    onOverwriteStylePreset: async () => false,
    onRenameStylePreset: async () => false,
    onPopOutEditor: () => undefined,
    onRemoveBubbleLayout: () => undefined,
    onSelectTransformMode: () => undefined,
    onStartAreaTranslate: () => undefined,
    onToggleEditorFloat: () => undefined,
    onUpdateBlock: () => undefined,
    onUpdateFormat: () => undefined,
    selectedBlock: null,
    selectedBlockCount: 0,
    selectedPageSize: { width: 1200, height: 1800 },
    showDetachControls: false,
    transformMode: "select",
    ...overrides,
  };
}
