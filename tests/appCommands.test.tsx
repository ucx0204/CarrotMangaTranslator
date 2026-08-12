/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/renderer/src/components/CommandPalette";
import { useAppCommands } from "../src/renderer/src/hooks/useAppCommands";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

afterEach(cleanup);
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("chapter display commands", () => {
  it("exposes both display toggles and runs their real command callbacks", () => {
    const toggleBlockChrome = vi.fn();
    const toggleTextBlocks = vi.fn();
    const { result } = renderHook(() =>
      useAppCommands({
        ...makeCommandOptions(),
        toggleBlockChrome,
        toggleTextBlocks,
      }),
    );

    const chrome = result.current.find(
      (command) => command.id === "toggle-block-chrome",
    );
    const blocks = result.current.find(
      (command) => command.id === "toggle-text-blocks",
    );
    expect(chrome?.label).toBe("배경/테두리 표시 전환");
    expect(blocks?.label).toBe("블록 표시 전환");

    act(() => chrome?.run());
    act(() => blocks?.run());
    expect(toggleBlockChrome).toHaveBeenCalledOnce();
    expect(toggleTextBlocks).toHaveBeenCalledOnce();
  });

  it("finds and executes the background/border toggle through the command palette UI", () => {
    const toggleBlockChrome = vi.fn();
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useAppCommands({
        ...makeCommandOptions(),
        toggleBlockChrome,
      }),
    );
    render(<CommandPalette open commands={result.current} onClose={onClose} />);

    fireEvent.change(screen.getByRole("textbox", { name: "명령 검색" }), {
      target: { value: "배경 테두리" },
    });
    fireEvent.click(
      screen.getByRole("option", { name: "배경/테두리 표시 전환" }),
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(toggleBlockChrome).toHaveBeenCalledOnce();
  });
});

function makeCommandOptions() {
  return {
    currentChapter: makeChapter(),
    jobActive: false,
    runAnalysis: vi.fn(),
    openTranslateOptions: vi.fn(),
    runCurrentPageInpainting: vi.fn(),
    cancelJob: vi.fn(),
    openImportPreview: vi.fn(async () => undefined),
    openShareImportPreview: vi.fn(async () => undefined),
    openSettings: vi.fn(),
    openLibraryFolder: vi.fn(),
    openLogFolder: vi.fn(),
    openErrorReport: vi.fn(),
    openTranslationSource: vi.fn(),
    openShareExport: vi.fn(),
    openShortcutHelp: vi.fn(),
    openTextView: vi.fn(),
    toggleBlockChrome: vi.fn(),
    toggleTextBlocks: vi.fn(),
  };
}

function makeChapter(): ChapterSnapshot {
  const now = "2026-08-11T00:00:00.000Z";
  return {
    id: "chapter-command-test",
    workId: "work-command-test",
    title: "명령 테스트",
    sourceKind: "images",
    status: "idle",
    pageOrder: [],
    pages: [],
    createdAt: now,
    updatedAt: now,
  };
}
