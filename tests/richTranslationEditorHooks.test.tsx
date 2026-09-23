/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRichTranslationEditorState } from "../src/renderer/src/components/useRichTranslationEditorState";
import { useRichTranslationVisualEditor } from "../src/renderer/src/components/useRichTranslationVisualEditor";
import {
  usePageEditHandoff,
  usePageInputActivity,
} from "../src/renderer/src/hooks/usePageEditHandoff";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { AppActivityState } from "../src/shared/appActivityTypes";
import { RichTranslationEditor } from "../src/renderer/src/components/RichTranslationEditor";
import { Modal } from "../src/renderer/src/components/ui/Modal";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { makeBlock } from "./helpers/workspacePointerFixtures";
import { restoreRichTextEditorSelection } from "../src/renderer/src/lib/richTextEditorDom";

function EditorFixture(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <FontsContext.Provider
      value={{
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        baseOptions: [],
        options: [],
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      <RichTranslationEditor
        block={makeBlock()}
        editorRootRef={React.createRef()}
        heightRefCallback={() => undefined}
        {...props}
        disabled={props.disabled ?? false}
      />
    </FontsContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rich translation editor hook boundaries", () => {
  it("closes special characters before the enclosing editor modal", () => {
    const onClose = vi.fn();
    const view = render(
      <Modal title="Edit block" onClose={onClose}>
        <EditorFixture value="Translation" onChange={vi.fn()} />
      </Modal>,
    );
    const trigger = view.getByRole("button", { name: /기호|특수문자/ });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("refreshes scaled glyph advances after font loading without changing text or selection", () => {
    const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts,
    });
    let advance = 10;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({
        width: advance * Array.from(text).length,
      }),
    } as CanvasRenderingContext2D);
    try {
      const onChange = vi.fn();
      const view = render(
        <EditorFixture value="[width=2]가나[/width]" onChange={onChange} />,
      );
      const visual = view.getByRole("textbox", { name: "번역문" });
      const width = () =>
        (
          visual.querySelector("[data-rich-text-glyph]")
            ?.parentElement as HTMLElement
        ).style.width;
      expect(width()).toBe("20px");
      visual.focus();
      restoreRichTextEditorSelection(visual, { start: 0, end: 1 });
      advance = 20;
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });
      expect(width()).toBe("40px");
      expect(document.getSelection()?.toString()).toBe("가");
      expect(onChange).not.toHaveBeenCalled();
      view.rerender(<EditorFixture value="plain" onChange={onChange} />);
      const firstChild = visual.firstChild;
      act(() => {
        fonts.dispatchEvent(new Event("loadingdone"));
      });
      expect(visual.firstChild).toBe(firstChild);
      view.unmount();
      expect(() => fonts.dispatchEvent(new Event("loadingdone"))).not.toThrow();
    } finally {
      if (fontsDescriptor)
        Object.defineProperty(document, "fonts", fontsDescriptor);
      else Reflect.deleteProperty(document, "fonts");
    }
  });
  it.each([false, true])(
    "preserves focus and copy while enforcing the visual/code write lock: %s",
    (disabled) => {
      const onChange = vi.fn();
      const view = render(
        <EditorFixture value="base" disabled={disabled} onChange={onChange} />,
      );
      const visual = view.getByRole("textbox", { name: "번역문" });
      visual.focus();
      expect(document.activeElement).toBe(visual);
      expect(visual.getAttribute("contenteditable")).toBe(String(!disabled));
      expect(
        fireEvent.keyPress(visual, {
          key: " ",
          charCode: 32,
          keyCode: 32,
          which: 32,
        }),
      ).toBe(!disabled);
      visual.textContent = "changed";
      fireEvent.input(visual);
      if (disabled) expect(onChange).not.toHaveBeenCalled();
      else expect(onChange).toHaveBeenLastCalledWith("changed");
      onChange.mockClear();
      fireEvent.paste(visual, { clipboardData: { getData: () => "paste" } });
      if (disabled) expect(onChange).not.toHaveBeenCalled();
      else expect(onChange).toHaveBeenCalled();
      fireEvent.click(view.getByRole("radio", { name: "코드" }));
      const code = view.getByRole("textbox", {
        name: "번역문 서식 코드",
      }) as HTMLTextAreaElement;
      code.focus();
      code.select();
      expect(document.activeElement).toBe(code);
      expect(code.selectionEnd).toBe(code.value.length);
      expect(code.readOnly).toBe(disabled);
      expect(code.disabled).toBe(false);
      onChange.mockClear();
      fireEvent.change(code, { target: { value: "new code" } });
      if (disabled) expect(onChange).not.toHaveBeenCalled();
      else expect(onChange).toHaveBeenLastCalledWith("new code");
    },
  );
  it("reuses an unchanged caret style but observes style edits at the same offset", () => {
    const { result } = renderHook(() => useRichTranslationEditorState("block"));
    const root = document.createElement("div");
    root.innerHTML =
      '<span data-rich-text-run data-bold="false" data-italic="false">text</span>';
    document.body.append(root);
    const run = root.firstElementChild as HTMLElement;
    const range = document.createRange();
    range.setStart(run.firstChild as Text, 1);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => result.current.recordVisualSelection(root, { start: 1, end: 1 }));
    const initialRun = result.current.caretRun;
    act(() => result.current.recordVisualSelection(root, { start: 1, end: 1 }));
    expect(result.current.caretRun).toBe(initialRun);
    run.dataset.bold = "true";
    act(() => result.current.recordVisualSelection(root, { start: 1, end: 1 }));
    expect(result.current.caretRun?.bold).toBe(true);
    run.dataset.color = "#112233";
    act(() => result.current.recordVisualSelection(root, { start: 1, end: 1 }));
    expect(result.current.caretRun?.color).toBe("#112233");
    act(() => result.current.recordVisualSelection(root, { start: 0, end: 2 }));
    expect(result.current.caretRun).toBeNull();
    root.remove();
  });
  it("does not commit unchanged selections and still tracks a new range immediately", () => {
    const committed = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <React.Profiler id="selection" onRender={committed}>
        {children}
      </React.Profiler>
    );
    const { result } = renderHook(
      () => useRichTranslationEditorState("block"),
      { wrapper },
    );
    act(() => result.current.setSelection({ start: 1, end: 5 }));
    committed.mockClear();
    for (let i = 0; i < 100; i++)
      act(() => result.current.setSelection({ start: 1, end: 5 }));
    expect(committed).not.toHaveBeenCalled();
    act(() => {
      result.current.setSelection({ start: 2, end: 6 });
      expect(result.current.selectionRef.current).toEqual({ start: 2, end: 6 });
    });
    expect(result.current.selection).toEqual({ start: 2, end: 6 });
    expect(committed).toHaveBeenCalledOnce();
  });
  it("saves the production IME fallback commit before acknowledging a page handoff", async () => {
    const acknowledge = vi.fn(async () => true);
    window.mangaApi = createTestMangaGatewayStub({
      finishPageEditHandoff: acknowledge,
    });
    const saved: string[] = [];
    const view = render(
      <HandoffEditor
        state={{ version: 0, activities: [], pages: [] }}
        saved={saved}
      />,
    );
    const editor = view.getByTestId("handoff-editor");
    fireEvent.compositionStart(editor);
    editor.textContent = "한글 입력 완료";
    view.rerender(
      <HandoffEditor
        state={{
          version: 1,
          activities: [],
          pages: [
            {
              jobId: "job",
              chapterId: "chapter",
              pageId: "B",
              requestId: "request",
              phase: "finishing-edits",
            },
          ],
        }}
        saved={saved}
      />,
    );
    expect(saved).toEqual([]);
    fireEvent.compositionEnd(editor);
    await waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    expect(saved).toEqual(["한글 입력 완료"]);
  });
  it("clears a pending typing style when the visual selection moves", () => {
    const { result } = renderHook(() =>
      useRichTranslationEditorState("block-1"),
    );
    const root = document.createElement("div");

    act(() => {
      result.current.updateTypingStyle({ bold: true });
      result.current.recordVisualSelection(root, { start: 0, end: 1 });
    });

    expect(result.current.typingStyle).toBeNull();
    expect(result.current.selection).toEqual({ start: 0, end: 1 });
  });

  it("clears composition commit timers on reset and unmount", () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = renderHook(() => {
      const state = useRichTranslationEditorState("block-1");
      React.useLayoutEffect(() => {
        state.compositionCommitTimerRef.current = window.setTimeout(
          () => undefined,
          100,
        );
      }, [state.compositionCommitTimerRef]);
      return state;
    });

    expect(clearTimeout).toHaveBeenCalled();
    act(() => {
      result.current.compositionCommitTimerRef.current = window.setTimeout(
        () => undefined,
        100,
      );
    });
    unmount();
    expect(clearTimeout).toHaveBeenCalledTimes(2);
  });

  it("ignores visual-only pointer and selection work without a visual root", () => {
    const onChange = vi.fn();
    const { result, rerender } = renderHook<
      ReturnType<typeof useRichTranslationVisualEditor>,
      { mode: "code" | "visual" }
    >(
      ({ mode }: { mode: "code" | "visual" }) => {
        const selectionState = useRichTranslationEditorState("block-1");
        return useRichTranslationVisualEditor({
          blockId: "block-1",
          mode,
          onChange,
          renderOptions: {
            baseBold: false,
            baseItalic: false,
            baseFontSizePx: 24,
            baseFontFamily: "sans-serif",
            baseOpacity: 1,
            resolveFontFamily: () => "sans-serif",
          },
          runs: [{ text: "문장", bold: false, italic: false }],
          selectionState,
          value: "문장",
        });
      },
      { initialProps: { mode: "code" } },
    );
    let capturedEvent: React.PointerEvent<HTMLDivElement> | null = null;
    const eventView = render(
      <div
        data-testid="outside"
        onPointerDown={(event) => {
          capturedEvent = event;
        }}
      >
        <div data-testid="visual-root">
          <span data-testid="visual-child" />
        </div>
      </div>,
    );
    const captureEvent = (
      target: Element,
    ): React.PointerEvent<HTMLDivElement> => {
      capturedEvent = null;
      fireEvent.pointerDown(target);
      if (!capturedEvent) throw new Error("Pointer event was not captured");
      return capturedEvent;
    };
    const event = captureEvent(eventView.getByTestId("outside"));

    act(() => result.current.captureSelectionBeforeControlFocus(event));
    rerender({ mode: "visual" });
    act(() => {
      result.current.captureSelectionBeforeControlFocus(event);
      result.current.updateSelection();
      result.current.commitInput();
    });
    const root = eventView.container.querySelector<HTMLDivElement>(
      '[data-testid="visual-root"]',
    );
    if (!root) throw new Error("Visual root was not rendered");
    result.current.visualRef.current = root;
    const childEvent = captureEvent(eventView.getByTestId("visual-child"));
    act(() => result.current.captureSelectionBeforeControlFocus(childEvent));

    expect(onChange).not.toHaveBeenCalled();
  });
});

function HandoffEditor({
  state,
  saved,
}: {
  state: AppActivityState;
  saved: string[];
}) {
  const value = React.useRef("base");
  usePageInputActivity("chapter", "B", state);
  usePageEditHandoff(state, async () => {
    saved.push(value.current);
  });
  const selectionState = useRichTranslationEditorState("block-1");
  const visual = useRichTranslationVisualEditor({
    blockId: "block-1",
    mode: "visual",
    value: "base",
    runs: [{ text: "base", bold: false, italic: false }],
    onChange: (text) => {
      value.current = text;
    },
    selectionState,
    renderOptions: {
      baseBold: false,
      baseItalic: false,
      baseFontSizePx: 24,
      baseFontFamily: "sans-serif",
      baseOpacity: 1,
      resolveFontFamily: () => "sans-serif",
    },
  });
  return (
    <div className="editor-panel">
      <div
        ref={visual.visualRef}
        data-testid="handoff-editor"
        contentEditable
        suppressContentEditableWarning
        onCompositionStart={visual.onCompositionStart}
        onCompositionEnd={visual.onCompositionEnd}
      />
    </div>
  );
}
