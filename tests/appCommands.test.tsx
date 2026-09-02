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
import { APP_COMMAND_IDS } from "../src/renderer/src/lib/appCommandTypes";
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

    const chrome = result.current.byId["toggle-block-chrome"];
    const blocks = result.current.byId["toggle-text-blocks"];
    expect(chrome.label).toBe("배경/테두리 표시 전환");
    expect(blocks.label).toBe("블록 표시 전환");

    act(() => result.current.run("toggle-block-chrome"));
    act(() => blocks.run());
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
    render(
      <CommandPalette
        open
        commands={result.current.paletteCommands}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "명령 검색" }), {
      target: { value: "배경 테두리" },
    });
    fireEvent.click(
      screen.getByRole("option", { name: "배경/테두리 표시 전환" }),
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(toggleBlockChrome).toHaveBeenCalledOnce();
  });

  it("keeps a complete typed map while exposing only context-valid palette entries", () => {
    const options = {
      ...makeCommandOptions(),
      currentChapter: null,
      jobActive: true,
    };
    const { result } = renderHook(() => useAppCommands(options));

    expect(Object.keys(result.current.byId)).toEqual(APP_COMMAND_IDS);
    expect(result.current.byId["translate-all"].paletteVisible).toBe(false);
    expect(result.current.byId["cancel-job"].paletteVisible).toBe(true);
    expect(result.current.paletteCommands.map(({ id }) => id)).not.toContain(
      "translate-all",
    );
    expect(result.current.paletteCommands.map(({ id }) => id)).toContain(
      "cancel-job",
    );
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
