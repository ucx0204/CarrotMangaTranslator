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
  it("registers the same add-pages command for a current chapter and blocks it while occupied", () => {
    const openAddChapterPages = vi.fn();
    const options = { ...makeCommandOptions(), openAddChapterPages };
    const { result, rerender } = renderHook(
      ({ busy }) => useAppCommands({ ...options, jobActive: busy }),
      { initialProps: { busy: false } },
    );
    expect(result.current.byId["add-chapter-pages"].label).toBe("페이지 추가");
    expect(result.current.byId["add-chapter-pages"].paletteVisible).toBe(true);
    act(() => result.current.run("add-chapter-pages"));
    expect(openAddChapterPages).toHaveBeenCalledOnce();
    rerender({ busy: true });
    act(() => result.current.run("add-chapter-pages"));
    expect(result.current.byId["add-chapter-pages"].paletteVisible).toBe(false);
    expect(openAddChapterPages).toHaveBeenCalledOnce();
  });
  it("routes page editing through the shared command and disables it during jobs", () => {
    const openPageEditor = vi.fn();
    const { result, rerender } = renderHook(
      ({ busy }) =>
        useAppCommands({
          ...makeCommandOptions(),
          openPageEditor,
          jobActive: busy,
        }),
      { initialProps: { busy: false } },
    );
    expect(result.current.byId["edit-pages"].label).toBe("페이지 편집");
    act(() => result.current.run("edit-pages"));
    expect(openPageEditor).toHaveBeenCalledOnce();
    rerender({ busy: true });
    act(() => result.current.run("edit-pages"));
    expect(result.current.byId["edit-pages"].paletteVisible).toBe(false);
    expect(openPageEditor).toHaveBeenCalledOnce();
    const absent = renderHook(() =>
      useAppCommands({ ...makeCommandOptions(), currentChapter: null }),
    );
    act(() => absent.result.current.run("edit-pages"));
    const unavailable = renderHook(() => useAppCommands(makeCommandOptions()));
    act(() => unavailable.result.current.run("edit-pages"));
  });
  it("keeps preparation and viewing commands available while model execution is occupied", () => {
    const options = {
      ...makeCommandOptions(),
      jobActive: true,
      translationUnavailable: true,
      redactionPreparation: { currentPageId: null, open: vi.fn() },
    };
    const { result } = renderHook(() => useAppCommands(options));
    for (const id of [
      "open-translate-options",
      "run-current-page-inpainting",
      "prepare-redaction-work",
      "gather-text",
      "open-batch",
      "open-share-export",
    ] as const) {
      expect(result.current.byId[id].paletteVisible).toBe(true);
    }
    expect(result.current.byId["translate-all"].paletteVisible).toBe(false);
    act(() => result.current.run("open-translate-options"));
    act(() => result.current.run("run-current-page-inpainting"));
    act(() => result.current.run("prepare-redaction-work"));
    expect(options.openTranslateOptions).toHaveBeenCalledOnce();
    expect(options.runCurrentPageInpainting).toHaveBeenCalledOnce();
    expect(options.redactionPreparation.open).toHaveBeenCalledWith({
      kind: "work",
      workId: options.currentChapter.workId,
    });
    expect(options.runAnalysis).not.toHaveBeenCalled();
  });
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
      screen.getByRole("option", { name: /배경\/테두리 표시 전환/ }),
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

    expect(Object.keys(result.current.byId).sort()).toEqual(
      [...APP_COMMAND_IDS].sort(),
    );
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

it("uses the region command's registered operation and tolerates an unavailable entry", () => {
  const startRegionTranslation = vi.fn();
  const { result } = renderHook(() =>
    useAppCommands({ ...makeCommandOptions(), startRegionTranslation }),
  );
  result.current.byId["translate-region"].run();
  expect(startRegionTranslation).toHaveBeenCalledOnce();
  const unavailable = renderHook(() => useAppCommands(makeCommandOptions()));
  expect(() =>
    unavailable.result.current.byId["translate-region"].run(),
  ).not.toThrow();
});
