// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSoundEffectPageEditor } from "../src/renderer/src/components/useSoundEffectPageEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("discards a cancelled creation draft and ignores its later pointerup", () => {
  const editor = fixture();
  editor.begin(1, 100, 200);
  editor.dispatch("pointermove", 1, 400, 600);
  expect(editor.result.current.creationBbox).toEqual({
    x: 100,
    y: 200,
    w: 300,
    h: 400,
  });

  editor.dispatch("pointercancel", 1, 400, 600);
  expect(editor.result.current.creationBbox).toBeNull();
  expect(editor.result.current.suppressClickRef.current).toBe(false);
  expect(editor.onCreateRegion).not.toHaveBeenCalled();
  expect(editor.onUpdateRegion).not.toHaveBeenCalled();

  editor.dispatch("pointerup", 1, 400, 600);
  editor.dispatch("pointermove", 1, 500, 700);
  expect(editor.onCreateRegion).not.toHaveBeenCalled();
  expect(editor.result.current.creationBbox).toBeNull();
});

it("commits a normal creation exactly once on pointerup", () => {
  const editor = fixture();
  editor.begin(1, 100, 200);
  editor.dispatch("pointermove", 1, 400, 600);
  editor.dispatch("pointerup", 1, 400, 600);
  expect(editor.onCreateRegion).toHaveBeenCalledExactlyOnceWith({
    x: 100,
    y: 200,
    w: 300,
    h: 400,
  });
  expect(editor.onUpdateRegion).not.toHaveBeenCalled();
  expect(editor.result.current.creationBbox).toBeNull();
  editor.dispatch("pointerup", 1, 400, 600);
  expect(editor.onCreateRegion).toHaveBeenCalledOnce();
});

it("ignores another pointer's move, cancellation and release without losing the active draft", () => {
  const editor = fixture();
  editor.begin(1, 100, 200);
  editor.dispatch("pointermove", 2, 900, 900);
  expect(editor.result.current.creationBbox).toBeNull();
  editor.dispatch("pointermove", 1, 400, 600);
  const draft = editor.result.current.creationBbox;
  editor.dispatch("pointercancel", 2, 900, 900);
  editor.dispatch("pointerup", 2, 900, 900);
  expect(editor.result.current.creationBbox).toEqual(draft);
  expect(editor.onCreateRegion).not.toHaveBeenCalled();
  editor.dispatch("pointerup", 1, 400, 600);
  expect(editor.onCreateRegion).toHaveBeenCalledExactlyOnceWith({
    x: 100,
    y: 200,
    w: 300,
    h: 400,
  });
});

function fixture() {
  const stage = document.createElement("div");
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 1000),
  );
  const stageRef = { current: stage };
  const visualSize = { width: 1000, height: 1000 };
  const onCreateRegion = vi.fn();
  const onUpdateRegion = vi.fn();
  const { result } = renderHook(() =>
    useSoundEffectPageEditor({
      stageRef,
      visualSize,
      onCreateRegion,
      onUpdateRegion,
    }),
  );
  return {
    result,
    onCreateRegion,
    onUpdateRegion,
    begin: (pointerId: number, clientX: number, clientY: number) => {
      const nativeEvent = pointer("pointerdown", pointerId, clientX, clientY);
      act(() =>
        result.current.beginCreate({
          pointerId,
          nativeEvent,
        } as React.PointerEvent),
      );
    },
    dispatch: (
      type: string,
      pointerId: number,
      clientX: number,
      clientY: number,
    ) => {
      act(() =>
        window.dispatchEvent(pointer(type, pointerId, clientX, clientY)),
      );
    },
  };
}

function pointer(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    clientY,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}
