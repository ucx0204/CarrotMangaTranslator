/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRichTranslationEditorState } from "../src/renderer/src/components/useRichTranslationEditorState";
import { useRichTranslationVisualEditor } from "../src/renderer/src/components/useRichTranslationVisualEditor";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("rich translation editor hook boundaries", () => {
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
