/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import {
  BubbleLayoutOption,
  TextEditorGroup,
} from "../src/renderer/src/components/EditorPanelSections";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

beforeEach(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    disconnect(): void {}

    observe(): void {}

    unobserve(): void {}
  };
  window.localStorage.setItem("editor.richText.mode", "code");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("editor text actions", () => {
  it("offers a repeated edit only after one simple translation change", () => {
    const onUpdate = vi.fn();
    const onSuggestConsistentEdit = vi.fn();
    const onEraseOriginal = vi.fn();
    const onFitBubble = vi.fn();
    render(
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <TextEditorGroup
          block={BLOCK}
          disabled={false}
          onEraseOriginal={onEraseOriginal}
          onFitBubble={onFitBubble}
          onSuggestConsistentEdit={onSuggestConsistentEdit}
          onUpdate={onUpdate}
        />
      </FontsContext.Provider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /번역문.*코드/ }), {
      target: { value: "카랜이 왔다" },
    });
    expect(screen.getByText("“렌” → “랜”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "비슷한 곳도 바꾸기" }));
    expect(onSuggestConsistentEdit).toHaveBeenCalledWith("렌", "랜");
    expect(screen.queryByText("“렌” → “랜”")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "OCR" }), {
      target: { value: "カランが来た" },
    });
    expect(onUpdate).toHaveBeenCalledWith({ sourceText: "カランが来た" });
    fireEvent.click(screen.getByRole("button", { name: /원문 지우기/ }));
    fireEvent.click(screen.getByRole("button", { name: /말풍선.*맞춤/ }));
    fireEvent.click(screen.getByRole("button", { name: "입력칸 높이 초기화" }));
    expect(onEraseOriginal).toHaveBeenCalledOnce();
    expect(onFitBubble).toHaveBeenCalledOnce();
  });

  it("removes an active bubble layout from its compact status control", () => {
    const onRemove = vi.fn();
    render(<BubbleLayoutOption disabled={false} onRemove={onRemove} />);

    expect(screen.getByRole("status").textContent).toContain(
      "말풍선 맞춤 적용됨",
    );
    fireEvent.click(screen.getByRole("button", { name: /말풍선.*해제/ }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

const BLOCK: TranslationBlock = {
  backgroundColor: "transparent",
  bbox: { h: 120, w: 200, x: 40, y: 50 },
  confidence: 1,
  fontSizePx: 32,
  id: "block-1",
  lineHeight: 1.2,
  opacity: 1,
  renderDirection: "horizontal",
  sourceDirection: "horizontal",
  sourceText: "カレンが来た",
  textAlign: "center",
  textColor: "#ffffff",
  translatedText: "카렌이 왔다",
  type: "nonsolid",
};

const FONTS_CONTEXT: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};
