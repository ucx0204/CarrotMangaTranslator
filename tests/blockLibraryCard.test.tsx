/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockLibraryEntryV1 } from "../src/shared/blockLibrary";
import { BlockLibraryCard } from "../src/renderer/src/components/BlockLibraryCard";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

const frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

beforeEach(() => {
  nextFrameId = 1;
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect(): void {}

      observe(): void {
        this.callback([], this);
      }

      unobserve(): void {}
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function getBoundingClientRect(this: HTMLElement): DOMRect {
      if (this.classList.contains("overlay-text-content")) {
        return rect(60, 70, 40, 20);
      }
      return rect(0, 0, 160, 160);
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
  } as CanvasRenderingContext2D);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(60, 70, 40, 20),
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(160);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  frames.clear();
});

describe("block library card", () => {
  it("renders a measured preview and exposes insert, edit, and delete actions", async () => {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const onInsert = vi.fn();
    render(
      <BlockLibraryCard
        busy={false}
        canInsert
        entry={ENTRY}
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        missingFont={false}
        onDelete={onDelete}
        onEdit={onEdit}
        onInsert={onInsert}
      />,
    );

    await flushAnimationFrames();
    await flushAnimationFrames();
    fireEvent.click(screen.getByRole("button", { name: "저장 블록" }));
    fireEvent.click(screen.getByRole("button", { name: "블록 편집" }));
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));

    expect(onInsert).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("falls back from a missing font and disables every mutation while busy", async () => {
    render(
      <BlockLibraryCard
        busy
        canInsert={false}
        entry={ENTRY}
        fontCatalog={DEFAULT_BLOCK_FONT_CATALOG}
        missingFont
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onInsert={vi.fn()}
      />,
    );

    await flushAnimationFrames();
    expect(screen.getByText("글꼴 없음 · 대체 글꼴로 미리보기")).toBeTruthy();
    expect(
      screen
        .getAllByRole("button")
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });
});

async function flushAnimationFrames(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(performance.now());
    await Promise.resolve();
  });
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    top: y,
    width,
    x,
    y,
    toJSON: () => ({ x, y, width, height }),
  } as DOMRect;
}

const ENTRY: BlockLibraryEntryV1 = {
  schemaVersion: 1,
  id: "library-entry",
  name: "저장 블록",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  block: {
    sourceText: "原文",
    translatedText: "번역",
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 48,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.7,
    size: { w: 300, h: 200 },
  },
};
