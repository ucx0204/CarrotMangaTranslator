/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransformEditorGroup } from "../src/renderer/src/components/TransformEditorGroup";
import {
  bboxFieldMaximumPixels,
  isPerspectiveVisibleOnPage,
  updateBboxFromPixels,
} from "../src/renderer/src/lib/transformEditorModel";
import {
  createCurvePreset,
  createIdentityWarpTransform,
  createWarpPreset,
} from "../src/shared/blockTransforms";
import type { TranslationBlock } from "../src/shared/textTypes";

afterEach(() => cleanup());

describe("dense transform editor", () => {
  it("shows one mode at a time and delegates mode changes", () => {
    const onSelectMode = vi.fn();
    renderEditor({ mode: "select", onSelectMode });

    expect(screen.getByText("비율 유지")).not.toBeNull();
    expect(screen.queryByText("빠른 모양")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "원근" }));
    expect(onSelectMode).toHaveBeenCalledWith("perspective");
  });

  it("commits a direct angle on Enter and restores a cancelled draft", () => {
    const onUpdate = vi.fn();
    renderEditor({ mode: "select", onUpdate });
    const angle = screen.getByRole("spinbutton", { name: "회전 값 (°)" });

    fireEvent.focus(angle);
    fireEvent.change(angle, { target: { value: "137.5" } });
    fireEvent.keyDown(angle, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith({ rotationDeg: 137.5 });

    onUpdate.mockClear();
    fireEvent.focus(angle);
    fireEvent.change(angle, { target: { value: "-42" } });
    fireEvent.keyDown(angle, { key: "Escape" });
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.focus(angle);
    fireEvent.change(angle, { target: { value: "270" } });
    fireEvent.keyDown(angle, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith({ rotationDeg: -90 });
  });

  it("does not create a history update when a numeric value is unchanged", () => {
    const onUpdate = vi.fn();
    renderEditor({ mode: "select", onUpdate });
    const x = screen.getByRole("spinbutton", { name: "X" });

    fireEvent.focus(x);
    fireEvent.blur(x);

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("starts and resets perspective without changing text formatting", () => {
    const onUpdate = vi.fn();
    const { rerender } = renderEditor({ mode: "perspective", onUpdate });
    fireEvent.click(screen.getByRole("button", { name: "원근 시작" }));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      perspectiveTransform: { version: 1 },
    });

    rerender(
      <TransformEditorGroup
        block={{
          ...makeBlock(),
          perspectiveTransform:
            onUpdate.mock.calls[0]?.[0].perspectiveTransform,
        }}
        disabled={false}
        mode="perspective"
        pageSize={{ width: 1000, height: 1000 }}
        onSelectMode={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "원근 초기화" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      perspectiveTransform: undefined,
    });
  });

  it("clears an invalid-corner warning when perspective is reset", () => {
    const onUpdate = vi.fn();
    renderEditor({
      mode: "perspective",
      onUpdate,
      block: makeBlock({
        perspectiveTransform: {
          version: 1,
          corners: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      }),
    });

    fireEvent.click(screen.getByText("꼭짓점 좌표"));
    const topLeftX = screen.getByRole("spinbutton", { name: "좌상 X" });
    fireEvent.change(topLeftX, { target: { value: "100" } });
    fireEvent.keyDown(topLeftX, { key: "Enter" });
    expect(
      screen.getByText("꼭짓점이 교차하거나 너무 가까워질 수 없어요."),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "원근 초기화" }));
    expect(
      screen.queryByText("꼭짓점이 교차하거나 너무 가까워질 수 없어요."),
    ).toBeNull();
  });

  it("keeps unsupported curve data and explains how to restore it", () => {
    renderEditor({
      mode: "curve",
      block: makeBlock({
        curveLayout: createCurvePreset("archUp"),
        renderDirection: "vertical",
      }),
    });

    expect(
      screen.getByText("곡선은 가로쓰기 한 줄에서 사용할 수 있어요."),
    ).not.toBeNull();
    expect(screen.getByText("일시 중지")).not.toBeNull();
    expect(screen.queryByText("빠른 모양")).toBeNull();
    expect(screen.getByRole("button", { name: "곡선 해제" })).not.toBeNull();
  });

  it("warns instead of silently crushing long text onto a short path", () => {
    renderEditor({
      mode: "curve",
      block: makeBlock({
        bbox: { x: 100, y: 100, w: 120, h: 80 },
        curveLayout: createCurvePreset("straight"),
        fontSizePx: 40,
        translatedText: "콰아아아아아아앙",
      }),
    });

    expect(screen.getByText(/글자가 경로보다 \d+px 깁니다/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "자간 맞추기" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "글자 한 단계 줄이기" }),
    ).not.toBeNull();
  });

  it("offers spacing fit only when spacing can actually solve overflow", () => {
    renderEditor({
      mode: "curve",
      block: makeBlock({
        bbox: { x: 100, y: 100, w: 120, h: 80 },
        curveLayout: createCurvePreset("straight"),
        fontSizePx: 40,
        letterSpacing: 0.2,
        translatedText: "콰아앙",
      }),
    });

    expect(screen.getByRole("button", { name: "자간 맞추기" })).not.toBeNull();
  });

  it("keeps warning when fit spacing cannot solve glyph overflow", () => {
    renderEditor({
      mode: "curve",
      block: makeBlock({
        bbox: { x: 100, y: 100, w: 120, h: 80 },
        curveLayout: {
          ...createCurvePreset("straight"),
          fitSpacing: true,
        },
        fontSizePx: 40,
        translatedText: "콰아아아아아아앙",
      }),
    });

    expect(screen.getByText(/글자가 경로보다 \d+px 깁니다/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "자간 맞추기" })).toBeNull();
  });

  it("resets every curve option, not only its path", () => {
    const onUpdate = vi.fn();
    renderEditor({
      mode: "curve",
      onUpdate,
      block: makeBlock({
        curveLayout: {
          ...createCurvePreset("archUp"),
          alignment: "end",
          offsetEm: 2,
          orientation: "upright",
          reversed: true,
          fitSpacing: true,
        },
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "곡선 초기화" }));
    expect(onUpdate).toHaveBeenCalledWith({
      curveLayout: createCurvePreset("straight"),
    });
  });

  it("starts a 3x3-cell warp and clears it with every other transform", () => {
    const onUpdate = vi.fn();
    const { rerender } = renderEditor({ mode: "warp", onUpdate });

    fireEvent.click(screen.getByRole("button", { name: "워프 시작" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      warpTransform: createIdentityWarpTransform(3),
    });

    rerender(
      <TransformEditorGroup
        block={makeBlock({
          rotationDeg: 20,
          curveLayout: createCurvePreset("archUp"),
          warpTransform: createWarpPreset("wave", 3),
        })}
        disabled={false}
        mode="warp"
        pageSize={{ width: 1000, height: 1000 }}
        onSelectMode={vi.fn()}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "모두 초기화" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      rotationDeg: 0,
      perspectiveTransform: undefined,
      curveLayout: undefined,
      warpTransform: undefined,
    });
  });

  it("resamples 3x3 to 5x5, applies presets, and edits a selected point", () => {
    const onUpdate = vi.fn();
    const warp = createWarpPreset("archUp", 3);
    renderEditor({
      mode: "warp",
      onUpdate,
      block: makeBlock({ warpTransform: warp }),
    });

    fireEvent.click(screen.getByRole("button", { name: "5×5" }));
    expect(onUpdate.mock.calls.at(-1)?.[0].warpTransform).toMatchObject({
      gridSize: 5,
      points: expect.arrayContaining([expect.any(Object)]),
    });
    expect(onUpdate.mock.calls.at(-1)?.[0].warpTransform.points).toHaveLength(
      36,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "프리셋" }));
    fireEvent.click(screen.getByRole("option", { name: "물결" }));
    expect(onUpdate).toHaveBeenLastCalledWith({
      warpTransform: createWarpPreset("wave", 3),
    });

    const x = screen.getByRole("spinbutton", { name: "X" });
    fireEvent.change(x, { target: { value: "5" } });
    fireEvent.keyDown(x, { key: "Enter" });
    expect(onUpdate.mock.calls.at(-1)?.[0].warpTransform.points[0].x).toBe(
      0.05,
    );
  });
});

describe("transform editor geometry safety", () => {
  it("keeps the block size when X/Y input reaches the page edge", () => {
    const bbox = { x: 100, y: 200, w: 300, h: 150 };
    const page = { width: 1000, height: 1000 };

    expect(bboxFieldMaximumPixels(bbox, "x", page, true)).toBe(700);
    expect(
      updateBboxFromPixels({
        bbox,
        field: "x",
        lockRatio: true,
        pageSize: page,
        value: 1000,
      }),
    ).toEqual({ x: 700, y: 200, w: 300, h: 150 });
  });

  it("limits ratio-locked growth by both remaining page axes", () => {
    const result = updateBboxFromPixels({
      bbox: { x: 100, y: 800, w: 400, h: 100 },
      field: "w",
      lockRatio: true,
      pageSize: { width: 1000, height: 1000 },
      value: 900,
    });

    expect(result).toEqual({ x: 100, y: 800, w: 800, h: 200 });
  });

  it("rejects a perspective quad that is completely outside the page", () => {
    const block = makeBlock({
      bbox: { x: 800, y: 100, w: 100, h: 100 },
      renderBbox: { x: 800, y: 100, w: 100, h: 100 },
    });

    expect(
      isPerspectiveVisibleOnPage(
        block,
        {
          version: 1,
          corners: [
            { x: 2, y: 0 },
            { x: 3, y: 0 },
            { x: 3, y: 1 },
            { x: 2, y: 1 },
          ],
        },
        { width: 1000, height: 1000 },
      ),
    ).toBe(false);
  });
});

function renderEditor({
  block = makeBlock(),
  mode,
  onSelectMode = vi.fn(),
  onUpdate = vi.fn(),
}: {
  block?: TranslationBlock;
  mode: "select" | "perspective" | "curve" | "warp";
  onSelectMode?: (mode: "select" | "perspective" | "curve" | "warp") => void;
  onUpdate?: (patch: Partial<TranslationBlock>) => void;
}) {
  return render(
    <TransformEditorGroup
      block={block}
      disabled={false}
      mode={mode}
      pageSize={{ width: 1000, height: 1000 }}
      onSelectMode={onSelectMode}
      onUpdate={onUpdate}
    />,
  );
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 120 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.3,
    autoFitText: false,
    ...patch,
  };
}
