/** @vitest-environment jsdom */

import React, { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import { useSelectedBlockKeyboardNudge } from "../src/renderer/src/hooks/useSelectedBlockKeyboardNudge";
import { useShortcutDispatcher } from "../src/renderer/src/hooks/useShortcutDispatcher";
import {
  nudgeBlockByImagePixels,
  resolveBlockNudgeDirection,
  resolveBlockNudgeDistancePx,
  resolveHeldBlockNudgeDelta,
  resolveSharedBlockNudgeDeltaPx,
} from "../src/renderer/src/lib/blockKeyboardNudge";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("block keyboard nudge model", () => {
  it("maps arrow keys and smoothly accelerates native key repeat", () => {
    expect(resolveBlockNudgeDirection("ArrowLeft")).toBe("left");
    expect(resolveBlockNudgeDirection("ArrowDown")).toBe("down");
    expect(resolveBlockNudgeDirection("Enter")).toBeNull();
    expect(resolveBlockNudgeDistancePx(0)).toBe(1);
    expect(resolveBlockNudgeDistancePx(300)).toBe(1);
    expect(resolveBlockNudgeDistancePx(500)).toBeCloseTo(1.11, 2);
    expect(resolveBlockNudgeDistancePx(1_200)).toBeCloseTo(2.81, 2);
    expect(resolveBlockNudgeDistancePx(2_200)).toBeCloseTo(6.52, 2);
    expect(resolveBlockNudgeDistancePx(3_000)).toBe(8);
    expect(resolveBlockNudgeDistancePx(5_000, true)).toBe(10);
  });

  it("changes continuously without speed steps while a key is held", () => {
    const samples = Array.from({ length: 28 }, (_, index) =>
      resolveBlockNudgeDistancePx(300 + index * 100),
    );
    expect(
      samples.every(
        (value, index) => index === 0 || value >= samples[index - 1],
      ),
    ).toBe(true);
    expect(
      samples.every(
        (value, index) =>
          index === 0 || Math.abs(value - samples[index - 1]) < 0.4,
      ),
    ).toBe(true);
  });

  it("normalizes diagonal movement and cancels opposing axes", () => {
    expect(resolveHeldBlockNudgeDelta(["ArrowRight", "ArrowDown"], 8)).toEqual({
      x: 8 * Math.SQRT1_2,
      y: 8 * Math.SQRT1_2,
    });
    expect(
      resolveHeldBlockNudgeDelta(["ArrowLeft", "ArrowRight", "ArrowUp"], 4),
    ).toEqual({ x: 0, y: -4 });
    expect(
      resolveHeldBlockNudgeDelta(["ArrowLeft", "ArrowRight"], 4),
    ).toBeNull();
  });

  it("converts natural image pixels and moves the pointer-editable box", () => {
    const block = makeBlock({
      bbox: { x: 100, y: 100, w: 200, h: 200 },
    });
    const moved = nudgeBlockByImagePixels(
      block,
      { width: 1_000, height: 2_000 },
      { x: 1, y: 1 },
    );
    expect(moved.bbox).toEqual(block.bbox);
    expect(moved.renderBbox).toEqual({
      x: 101,
      y: 100.5,
      w: 200,
      h: 200,
    });
  });

  it("moves an explicit render box without changing its source box", () => {
    const block = makeBlock({
      bbox: { x: 100, y: 100, w: 80, h: 80 },
      renderBbox: { x: 200, y: 250, w: 300, h: 180 },
      renderBboxSpace: "normalized_1000",
    });
    const moved = nudgeBlockByImagePixels(
      block,
      { width: 1_000, height: 1_000 },
      { x: -2, y: 4 },
    );
    expect(moved.bbox).toEqual(block.bbox);
    expect(moved.renderBbox).toEqual({
      x: 198,
      y: 254,
      w: 300,
      h: 180,
    });
  });

  it("ignores the source boundary when moving the render box", () => {
    const block = makeBlock({
      bbox: { x: 850, y: 100, w: 100, h: 100 },
      renderBbox: { x: 700, y: 80, w: 100, h: 140 },
      renderBboxSpace: "normalized_1000",
    });
    const shared = resolveSharedBlockNudgeDeltaPx(
      [block],
      { width: 1_000, height: 1_000 },
      { x: 100, y: 0 },
    );
    const moved = nudgeBlockByImagePixels(
      block,
      { width: 1_000, height: 1_000 },
      shared,
    );

    expect(shared).toEqual({ x: 100, y: 0 });
    expect(moved.bbox).toEqual(block.bbox);
    expect(moved.renderBbox).toEqual({ x: 800, y: 80, w: 100, h: 140 });
  });

  it("stops only when eight normalized units would remain hidden", () => {
    const block = makeBlock({
      bbox: { x: 790, y: 0, w: 200, h: 200 },
    });
    const moved = nudgeBlockByImagePixels(
      block,
      { width: 1_000, height: 1_000 },
      { x: 1_000, y: -1_000 },
    );
    expect(moved.bbox).toEqual(block.bbox);
    expect(moved.renderBbox).toEqual({ x: 992, y: -192, w: 200, h: 200 });
  });

  it("clamps a multi-selection as one group at page edges", () => {
    const left = makeBlock({
      id: "left",
      bbox: { x: 100, y: 100, w: 200, h: 200 },
    });
    const right = makeBlock({
      id: "right",
      bbox: { x: 790, y: 100, w: 200, h: 200 },
    });
    const shared = resolveSharedBlockNudgeDeltaPx(
      [left, right],
      { width: 1_000, height: 1_000 },
      { x: 1_000, y: 0 },
    );
    expect(shared).toEqual({ x: 202, y: 0 });
    expect(
      nudgeBlockByImagePixels(left, { width: 1_000, height: 1_000 }, shared)
        .renderBbox?.x,
    ).toBe(302);
    expect(
      nudgeBlockByImagePixels(right, { width: 1_000, height: 1_000 }, shared)
        .renderBbox?.x,
    ).toBe(992);
  });
});

describe("selected block keyboard nudge", () => {
  it("moves exactly 1 px for a quick arrow tap", () => {
    vi.useFakeTimers();
    const onNudge = vi.fn();
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    render(<NudgeHarness onNudge={onNudge} />);
    screen.getByTestId("workspace").focus();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    clock = 350;
    act(() => vi.advanceTimersByTime(250));
    fireEvent.keyUp(window, { key: "ArrowRight" });
    clock = 1_000;
    act(() => vi.advanceTimersByTime(1_000));

    expect(onNudge.mock.calls).toEqual([[{ x: 1, y: 0 }]]);
  });

  it("uses one app-owned cadence and resets acceleration after all keys lift", () => {
    vi.useFakeTimers();
    const onNudge = vi.fn();
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    render(<NudgeHarness onNudge={onNudge} />);
    const workspace = screen.getByTestId("workspace");
    workspace.focus();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    expect(onNudge).toHaveBeenCalledTimes(1);

    clock = 400;
    act(() => vi.advanceTimersByTime(300));
    clock = 1_400;
    act(() => vi.advanceTimersByTime(40));
    fireEvent.keyUp(window, { key: "ArrowRight" });
    clock = 1_500;
    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(onNudge.mock.calls).toEqual([
      [{ x: 1, y: 0 }],
      [{ x: 1, y: 0 }],
      [{ x: resolveBlockNudgeDistancePx(1_300), y: 0 }],
      [{ x: 1, y: 0 }],
    ]);
  });

  it("uses Shift+arrow for a fixed 10 px editor nudge", () => {
    const onNudge = vi.fn();
    render(<NudgeHarness onNudge={onNudge} />);
    screen.getByTestId("workspace").focus();
    fireEvent.keyDown(window, { key: "ArrowUp", shiftKey: true });
    expect(onNudge).toHaveBeenCalledWith({ x: 0, y: -10 });
  });

  it("combines simultaneously held arrows into a smooth diagonal", () => {
    vi.useFakeTimers();
    const onNudge = vi.fn();
    let clock = 100;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    render(<NudgeHarness onNudge={onNudge} />);
    screen.getByTestId("workspace").focus();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    clock = 200;
    fireEvent.keyDown(window, { key: "ArrowDown" });
    const diagonalDistance = resolveBlockNudgeDistancePx(100) * Math.SQRT1_2;
    expect(onNudge).toHaveBeenLastCalledWith({
      x: diagonalDistance,
      y: diagonalDistance,
    });

    onNudge.mockClear();
    fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(window, { key: "ArrowDown", repeat: true });
    expect(onNudge).not.toHaveBeenCalled();
    clock = 400;
    act(() => vi.advanceTimersByTime(300));
    expect(onNudge).toHaveBeenCalledTimes(1);

    onNudge.mockClear();
    clock = 3_100;
    act(() => vi.advanceTimersByTime(40));
    expect(onNudge).toHaveBeenCalledTimes(1);

    fireEvent.keyUp(window, { key: "ArrowRight" });
    onNudge.mockClear();
    clock = 3_140;
    act(() => vi.advanceTimersByTime(40));
    expect(onNudge).toHaveBeenLastCalledWith({ x: 0, y: 8 });
  });

  it("leaves arrows alone while blocked or an editor control has focus", () => {
    const onNudge = vi.fn();
    const { rerender } = render(<NudgeHarness blocked onNudge={onNudge} />);
    screen.getByTestId("workspace").focus();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onNudge).not.toHaveBeenCalled();

    rerender(<NudgeHarness onNudge={onNudge} />);
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(onNudge).not.toHaveBeenCalled();

    const tab = screen.getByRole("tab");
    tab.focus();
    fireEvent.keyDown(tab, { key: "ArrowLeft" });
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("owns workspace arrow keys before page-navigation aliases dispatch", () => {
    const onNudge = vi.fn();
    const onNextPage = vi.fn();
    render(
      <NudgeAndShortcutHarness onNextPage={onNextPage} onNudge={onNudge} />,
    );
    const workspace = screen.getByTestId("workspace");
    workspace.focus();

    fireEvent.keyDown(workspace, {
      key: "ArrowRight",
      code: "ArrowRight",
    });
    fireEvent.keyUp(workspace, { key: "ArrowRight", code: "ArrowRight" });

    expect(onNudge).toHaveBeenCalledWith({ x: 1, y: 0 });
    expect(onNextPage).not.toHaveBeenCalled();
  });
});

function NudgeHarness({
  blocked = false,
  onNudge,
}: {
  blocked?: boolean;
  onNudge: (delta: { x: number; y: number }) => void;
}): React.JSX.Element {
  const workspacePanelRef = useRef<HTMLDivElement | null>(null);
  useSelectedBlockKeyboardNudge({
    blocked,
    enabled: true,
    onNudge,
    workspacePanelRef,
  });
  return (
    <div ref={workspacePanelRef} data-testid="workspace" tabIndex={0}>
      <input aria-label="editor" />
      <button role="tab">Format</button>
    </div>
  );
}

function NudgeAndShortcutHarness({
  onNextPage,
  onNudge,
}: {
  onNextPage: () => void;
  onNudge: (delta: { x: number; y: number }) => void;
}): React.JSX.Element {
  const workspacePanelRef = useRef<HTMLDivElement | null>(null);
  useSelectedBlockKeyboardNudge({
    blocked: false,
    enabled: true,
    onNudge,
    workspacePanelRef,
  });
  useShortcutDispatcher({
    context: {
      activeModalActionId: null,
      blockingModalOpen: false,
      paletteOpen: false,
      helpOpen: false,
      chapterOpen: true,
      editLocked: false,
      jobActive: false,
      retouchToolActive: false,
      blockSelected: true,
    },
    handlers: { "page-next": onNextPage },
    overrides: {},
  });
  return (
    <div ref={workspacePanelRef} data-testid="workspace" tabIndex={0}>
      <input aria-label="editor" />
    </div>
  );
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    bboxSpace: "normalized_1000",
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
    ...patch,
  };
}
