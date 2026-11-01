/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterTaskHub } from "../src/renderer/src/components/RunStatusPanels";
import { UnifiedRightRail } from "../src/renderer/src/components/rightRailPanels";
import { CommandPalette } from "../src/renderer/src/components/CommandPalette";
import type { ChapterTaskHubProps } from "../src/renderer/src/components/chapterTaskHubTypes";
import { createExportOptionsProps } from "../src/renderer/src/app/session/createAppOverlayProps";
import { createShortcutHandlers } from "../src/renderer/src/app/session/useAppSessionShortcuts";
import { useAppSessionCommandController } from "../src/renderer/src/app/session/useAppSessionCommandController";
import { useAppSessionUiState } from "../src/renderer/src/app/session/useAppSessionUiState";
import type { LinkedWorkspaceStatus } from "../src/shared/linkedWorkspaceTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { AppSettings } from "../src/shared/settingsTypes";
import {
  makeChapter,
  makePage,
  makeRightRailProps,
} from "./unifiedInpaintingUiFixtures";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("chapter output row in the task hub", () => {
  it("sits directly under translation, separate from page actions", () => {
    const props = makeHubProps();
    render(<ChapterTaskHub {...props} />);

    const output = screen.getByRole("group", { name: "화 결과물 출력" });
    const translate = screen.getByRole("button", { name: "일반 번역" });
    const pageActions = screen.getByRole("heading", { name: "페이지 작업" });
    expect(isBefore(translate, output)).toBe(true);
    expect(isBefore(output, pageActions)).toBe(true);
    expect(
      [...document.querySelectorAll(".current-page-actions button")].map(
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(["현재 페이지 원문 지우기", "현재 페이지 말풍선 자동 감지"]);

    fireEvent.click(
      within(output).getByRole("button", { name: "결과물 출력" }),
    );
    fireEvent.click(within(output).getByRole("button", { name: "PSD 출력" }));
    expect(props.onOpenExport).toHaveBeenCalledOnce();
    expect(props.onOpenPsdExport).toHaveBeenCalledOnce();
  });

  it("stays available without a selected page and beside running jobs", () => {
    render(
      <ChapterTaskHub
        {...makeHubProps({ hasSelectedPage: false, jobActive: true })}
      />,
    );

    expect(screen.queryByRole("heading", { name: "페이지 작업" })).toBeNull();
    expect(exportButton("결과물 출력").disabled).toBe(false);
    expect(exportButton("PSD 출력").disabled).toBe(false);
  });

  it("is disabled for an empty chapter", () => {
    const empty = { ...makeChapter(), pageOrder: [], pages: [] };
    const props = makeHubProps({
      currentChapter: empty,
      hasSelectedPage: false,
    });
    render(<ChapterTaskHub {...props} />);

    expect(exportButton("결과물 출력").disabled).toBe(true);
    expect(exportButton("PSD 출력").disabled).toBe(true);
    fireEvent.click(exportButton("결과물 출력"));
    expect(props.onOpenExport).not.toHaveBeenCalled();
  });

  it("adds linked-workspace results as their own button instead of replacing export", () => {
    const props = makeHubProps({ linkedWorkspaceStatus: linkedStatus("idle") });
    const view = render(<ChapterTaskHub {...props} />);
    const output = screen.getByRole("group", { name: "화 결과물 출력" });

    expect(
      within(output)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["결과물 출력", "PSD 출력", "결과물 보기"]);
    fireEvent.click(
      within(output).getByRole("button", { name: "결과물 보기" }),
    );
    fireEvent.click(
      within(output).getByRole("button", { name: "결과물 출력" }),
    );
    expect(props.onViewLinkedResults).toHaveBeenCalledOnce();
    expect(props.onOpenExport).toHaveBeenCalledOnce();
    expect(within(output).getByText("최신 결과 저장됨")).not.toBeNull();

    view.rerender(<ChapterTaskHub {...props} linkedWorkspaceViewBusy={true} />);
    expect(
      screen.getByRole("button", { name: "결과물 보기" }).textContent,
    ).toBe("최신 결과 준비 중…");

    view.rerender(
      <ChapterTaskHub
        {...props}
        linkedWorkspaceStatus={linkedStatus("disabled")}
      />,
    );
    // Results stay reachable while automatic saving is off.
    fireEvent.click(screen.getByRole("button", { name: "결과물 보기" }));
    expect(props.onViewLinkedResults).toHaveBeenCalledTimes(2);
    expect(exportButton("결과물 출력").disabled).toBe(false);
    expect(screen.getByText("결과물 자동 저장 꺼짐")).not.toBeNull();
  });

  it("names the current folder and shows a move in progress", () => {
    const status = { ...linkedStatus("idle"), rootName: "프롤로그" };
    const view = render(
      <ChapterTaskHub {...makeHubProps({ linkedWorkspaceStatus: status })} />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "‘프롤로그’ 폴더에 저장됨",
    );

    view.rerender(
      <ChapterTaskHub
        {...makeHubProps({
          linkedWorkspaceStatus: {
            ...status,
            organization: { state: "moving" },
          },
        })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("결과 폴더 옮기는 중…");
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("offers a local retry for a failed move without sending users to settings", () => {
    const props = makeHubProps({
      linkedWorkspaceStatus: {
        ...linkedStatus("idle"),
        organization: { state: "failed", error: "폴더를 사용 중입니다." },
      },
    });
    render(<ChapterTaskHub {...props} />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "결과 폴더를 옮기지 못했습니다폴더를 사용 중입니다.",
    );
    expect(document.body.textContent).not.toContain("설정");
    expect(document.body.textContent).not.toContain("자동 저장 실패");
    expect(screen.getByRole("status").textContent).toBe(
      "파일 보호를 위해 자동 저장 중지",
    );
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(props.onRetryLinkedResults).toHaveBeenCalledOnce();
  });

  it("keeps long failure details expandable without losing the original reason", () => {
    const reason = `앱 밖에서 변경된 파일이 있습니다: C:/${"long-folder/".repeat(25)}001.png`;
    render(
      <ChapterTaskHub
        {...makeHubProps({
          linkedWorkspaceStatus: {
            ...linkedStatus("idle"),
            organization: { state: "failed", error: reason },
          },
        })}
      />,
    );
    const details = screen.getByRole("button", { name: "오류 내용 펼치기" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(
      screen
        .getByRole("button", { name: "오류 내용 접기" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText(reason).getAttribute("data-expanded")).toBe("true");
  });

  it("tells preserved files apart from failures and opens the previous folder", () => {
    const props = makeHubProps({
      linkedWorkspaceStatus: {
        ...linkedStatus("idle"),
        organization: {
          state: "idle",
          preservedRootPaths: ["C:/results/old/1화"],
        },
      },
    });
    render(<ChapterTaskHub {...props} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("이전 폴더에 남은 파일이 있습니다")).not.toBeNull();
    expect(document.body.textContent).not.toContain("C:/results");
    fireEvent.click(screen.getByRole("button", { name: "이전 폴더 열기" }));
    expect(props.onOpenPreviousLinkedResults).toHaveBeenCalledOnce();
  });

  it("shows the sync error itself instead of a settings instruction", () => {
    render(
      <ChapterTaskHub
        {...makeHubProps({
          linkedWorkspaceStatus: {
            ...linkedStatus("failed"),
            lastError: "디스크 공간이 부족합니다.",
          },
        })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("자동 저장 실패");
    expect(screen.getByRole("alert").textContent).toBe(
      "디스크 공간이 부족합니다.",
    );
    expect(document.body.textContent).not.toContain("설정");
  });

  it("names the buttons from the shared command labels", () => {
    const { result } = renderHook(() => useExportHarness(makeChapter()));
    render(
      <UnifiedRightRail
        {...makeRightRailProps({ rightRailMode: "page-blocks" })}
        selectedPage={null}
        commandLabels={{
          ...result.current.commands.labels,
          "open-psd-export-options": "레이어 PSD",
        }}
      />,
    );

    expect(exportButton("결과물 출력")).not.toBeNull();
    expect(exportButton("레이어 PSD")).not.toBeNull();
  });
});

describe("output commands", () => {
  it("open both export kinds from the palette with the button names", () => {
    const { result } = renderHook(() => useExportHarness(makeChapter()));
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        commands={result.current.commands.paletteCommands}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "명령 검색" }), {
      target: { value: "PSD" },
    });
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: "PSD 출력" }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(result.current.uiState.exportOptionsOpen).toBe(true);
    expect(result.current.uiState.exportOptionsKind).toBe("psd");
    expect(result.current.commands.byId["open-export-options"].label).toBe(
      "결과물 출력",
    );
  });

  it("toggles raster export with the export shortcut through the shared command", () => {
    const { result } = renderHook(() => useExportHarness(makeChapter()));

    act(() => result.current.commands.run("open-psd-export-options"));
    expect(result.current.uiState.exportOptionsKind).toBe("psd");
    act(() => result.current.handlers["open-export-options"]());
    expect(result.current.uiState.exportOptionsOpen).toBe(false);
    act(() => result.current.handlers["open-export-options"]());
    expect(result.current.uiState.exportOptionsOpen).toBe(true);
    expect(result.current.uiState.exportOptionsKind).toBe("raster");
  });

  it("hides and refuses export without pages, but not while a job runs", () => {
    const empty = { ...makeChapter(), pageOrder: [], pages: [] };
    for (const chapter of [empty, null]) {
      const { result } = renderHook(() => useExportHarness(chapter));
      const ids = result.current.commands.paletteCommands.map(({ id }) => id);
      expect(ids).not.toContain("open-export-options");
      expect(ids).not.toContain("open-psd-export-options");
      act(() => result.current.handlers["open-export-options"]());
      act(() => result.current.commands.run("open-psd-export-options"));
      expect(result.current.uiState.exportOptionsOpen).toBe(false);
    }

    const busy = renderHook(() => useExportHarness(makeChapter(), true));
    expect(
      busy.result.current.commands.byId["open-export-options"].paletteVisible,
    ).toBe(true);
  });
});

describe("export modal props", () => {
  it("falls back to the first page when no page is selected", () => {
    const second = { ...makePage(), id: "page-2" };
    const chapter = { ...makeChapter(), pages: [makePage(), second] };
    const model = makeExportModel(chapter, null);
    expect(exportProps(model)?.currentPageId).toBe("page-1");

    const selected = makeExportModel(chapter, second);
    expect(exportProps(selected)?.currentPageId).toBe("page-2");
  });

  it("opens nothing for an empty chapter or a closed modal", () => {
    const empty = { ...makeChapter(), pageOrder: [], pages: [] };
    expect(exportProps(makeExportModel(empty, null))).toBeNull();
    const closed = makeExportModel(makeChapter(), null);
    closed.uiState.exportOptionsOpen = false;
    expect(exportProps(closed)).toBeNull();
  });

  it("starts the job matching the requested kind", () => {
    const model = makeExportModel(makeChapter(), null);
    model.uiState.exportOptionsKind = "psd";
    expect(exportProps(model)?.onStart).toBe(
      model.inpaintingActions.exportPagePsd,
    );
  });

  it("restores saved output choices and saves them through the dedicated owner", () => {
    const model = makeExportModel(makeChapter(), null);
    const props = exportProps(model);
    expect(props?.savedPreferences).toEqual(SAVED_EXPORT_PREFERENCES);
    // Never a whole-settings write, which could carry a stale copy.
    expect(props?.onPersistPreferences).toBe(
      model.settingsDialog.saveExportPreferences,
    );
  });
});

function useExportHarness(chapter: ChapterSnapshot | null, jobActive = false) {
  const uiState = useAppSessionUiState();
  const commands = useAppSessionCommandController({
    ...uiState,
    redactionPreparation: { currentPageId: null, open: vi.fn() },
    startRegionTranslation: vi.fn(),
    cancelJob: vi.fn(),
    currentChapter: chapter,
    jobActive,
    openImportPreview: async () => {},
    openLibraryFolder: vi.fn(),
    openLogFolder: vi.fn(),
    openErrorReport: vi.fn(),
    openSettings: vi.fn(),
    openShareImportPreview: async () => {},
    runAnalysis: vi.fn(),
    runCurrentPageInpainting: vi.fn(),
    setShareExportOpen: vi.fn(),
    setTranslationSourceOpen: vi.fn(),
    setAddPagesChapter: vi.fn(),
  });
  const handlers = createShortcutHandlers({
    chapter: {
      core: { currentChapter: chapter },
      settingsDialog: { settings: null },
      uiState,
    } as never,
    translation: { blockEditingActions: {}, workspaceHistory: {} } as never,
    inpainting: { commandRegistry: commands } as never,
  });
  return { commands, handlers, uiState };
}

function makeExportModel(
  chapter: ChapterSnapshot,
  selectedPage: ChapterSnapshot["pages"][number] | null,
) {
  return {
    core: {
      currentChapter: chapter,
      library: { works: [] },
      setSelectedBlockId: vi.fn(),
      setSelectedPageId: vi.fn(),
    },
    derivedState: { selectedPage },
    inpaintingActions: {
      exportPageImages: vi.fn(),
      exportPagePsd: vi.fn(),
    },
    libraryActions: { openChapter: vi.fn() },
    settingsDialog: {
      settings: {
        ui: {
          locale: "ko",
          exportPreferences: { ...SAVED_EXPORT_PREFERENCES },
        },
      } as AppSettings | null,
      saveExportPreferences: vi.fn(async () => true),
    },
    uiState: {
      exportOptionsKind: "raster" as "raster" | "psd",
      exportOptionsOpen: true,
      setExportOptionsOpen: vi.fn(),
    },
  };
}

const SAVED_EXPORT_PREFERENCES = {
  outputFormat: "png",
  jpegQuality: 95,
  webpQuality: 90,
  preserveSourceNames: false,
  destinationMode: "fixed",
} as const;

function exportProps(model: ReturnType<typeof makeExportModel>) {
  // The fixture provides only the fields the export modal reads.
  return createExportOptionsProps(model as never);
}

function makeHubProps(
  overrides: Partial<ChapterTaskHubProps> = {},
): ChapterTaskHubProps {
  return {
    canRunBubbleLayout: false,
    currentChapter: makeChapter(),
    exportLabel: "결과물 출력",
    flowActive: false,
    hasSelectedPage: true,
    jobActive: false,
    linkedWorkspaceStatus: null,
    linkedWorkspaceViewBusy: false,
    linkedWorkspaceOrganizing: false,
    viewResultsLabel: "결과물 보기",
    onRetryLinkedResults: vi.fn(),
    onOpenPreviousLinkedResults: vi.fn(),
    onOpenAutoInpaintingOptions: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenExport: vi.fn(),
    onOpenPsdExport: vi.fn(),
    onOpenTranslateOptions: vi.fn(),
    onRunBubbleLayout: vi.fn(),
    onViewLinkedResults: vi.fn(),
    psdExportLabel: "PSD 출력",
    ...overrides,
  };
}

function linkedStatus(
  state: LinkedWorkspaceStatus["state"],
): LinkedWorkspaceStatus {
  return {
    chapterId: "chapter-1",
    connectionId: "connection-1",
    failedCount: 0,
    pendingCount: 0,
    state,
  };
}

function exportButton(name: string): HTMLButtonElement {
  return within(
    screen.getByRole("group", { name: "화 결과물 출력" }),
  ).getByRole("button", { name }) as HTMLButtonElement;
}

function isBefore(first: Element, second: Element): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}
