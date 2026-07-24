/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { AppRightRail } from "../src/renderer/src/components/AppRightRail";
import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import { DisplayControlPanel } from "../src/renderer/src/components/inpaintingPanel/DisplayControlPanel";
import { StageToolbar } from "../src/renderer/src/components/StageToolbar";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import {
  DEFAULT_BLOCK_FONT_CATALOG,
  getBaseBlockFontOptions,
  getBlockFontOptions,
} from "../src/renderer/src/lib/fonts";
import {
  PanelSessionContext,
  type PanelSessionValue,
} from "../src/renderer/src/panels/panelSession";

class ResizeObserverStub {
  disconnect(): void {}

  observe(): void {}

  unobserve(): void {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(() => cleanup());

describe("unified workspace toolbar", () => {
  it("renders one mutually-exclusive toolbar for translation and retouch tools", () => {
    const onSelectTool = vi.fn();
    const onToggleRegionTranslation = vi.fn();
    render(
      <StageToolbar
        brushColor="#fa8128"
        brushRadius={28}
        disabled={false}
        hidden={false}
        onSelectTool={onSelectTool}
        onToggleRegionTranslation={onToggleRegionTranslation}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="brush"
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(11);
    expect(screen.getByRole("button", { name: "원근" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "곡선" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "브러시" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("브러시");
    expect(screen.getByRole("status").textContent).toContain("28px");
    expect(screen.getByRole("status").textContent).toContain("·");
    expect(screen.getByRole("tooltip", { name: "보정 브러시" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "브러시" }).hasAttribute("title"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "마스크" }));
    expect(onSelectTool).toHaveBeenCalledWith("mask");

    fireEvent.click(screen.getByRole("button", { name: "원근" }));
    expect(onSelectTool).toHaveBeenCalledWith("perspective");

    fireEvent.click(screen.getByRole("button", { name: "곡선" }));
    expect(onSelectTool).toHaveBeenCalledWith("curve");

    fireEvent.click(screen.getByRole("button", { name: "영역 번역" }));
    expect(onToggleRegionTranslation).toHaveBeenCalledOnce();
  });

  it("keeps region translation visible and exposes its active state", () => {
    render(
      <StageToolbar
        brushColor="#ffffff"
        brushRadius={20}
        disabled={false}
        hidden={false}
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={true}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );

    const regionButton = screen.getByRole("button", { name: "영역 번역" });
    const selectButton = screen.getByRole("button", { name: "선택" });
    expect(regionButton.getAttribute("aria-pressed")).toBe("true");
    expect(selectButton.getAttribute("aria-pressed")).toBe("false");
    expect(selectButton.classList.contains("active")).toBe(false);
    expect((regionButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables region translation until the selected page image is ready", () => {
    render(
      <StageToolbar
        brushColor="#ffffff"
        brushRadius={20}
        disabled={false}
        hidden={false}
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={false}
        tool="select"
      />,
    );

    expect(
      (
        screen.getByRole("button", {
          name: "영역 번역",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("disables every interaction tool while a job owns the canvas", () => {
    render(
      <StageToolbar
        brushColor="#ffffff"
        brushRadius={20}
        disabled={true}
        hidden={false}
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );

    for (const name of [
      "선택",
      "블록",
      "영역 번역",
      "손바닥",
      "마스크",
      "브러시",
      "지우개",
      "색 추출",
    ]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
  });
});

describe("unified right rail", () => {
  it("uses app tooltips instead of native titles for display controls", () => {
    render(
      <DisplayControlPanel
        showBlockChrome={true}
        showTextBlocks={false}
        canOpenTextView={true}
        onToggleChrome={() => undefined}
        onToggleBlocks={() => undefined}
        onOpenTextView={() => undefined}
        onOpenStyleGuide={() => undefined}
      />,
    );

    const backgroundControl = screen.getByRole("button", {
      name: "배경/테두리",
    });
    const tooltip = screen.getByRole("tooltip", { name: "배경/테두리" });
    expect(backgroundControl.hasAttribute("title")).toBe(false);
    expect(backgroundControl.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(backgroundControl.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("runs the current page directly and keeps page selection secondary", () => {
    const props = makeRightRailProps();
    renderRightRail(props);

    expect(
      (screen.getByRole("button", { name: "번역" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "현재 페이지 자동 지우기",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "PNG 출력" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "PNG 출력" }));
    expect(props.onOpenExport).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menuitem", { name: "여러 페이지 선택…" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "현재 페이지 자동 지우기" }),
    );
    expect(props.onRunCurrentPageInpainting).toHaveBeenCalledOnce();
    expect(props.onOpenAutoInpaintingOptions).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "자동 지우기 추가 작업" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "여러 페이지 선택…" }),
    );
    expect(props.onOpenAutoInpaintingOptions).toHaveBeenCalledOnce();
  });

  it("closes and disables the automatic erase menu when work becomes busy", () => {
    const props = makeRightRailProps();
    const view = renderRightRail(props);

    fireEvent.click(
      screen.getByRole("button", { name: "자동 지우기 추가 작업" }),
    );
    const firstMenuItem = screen.getByRole("menuitem", {
      name: "여러 페이지 선택…",
    });
    expect(firstMenuItem).not.toBeNull();
    expect(document.activeElement).toBe(firstMenuItem);

    fireEvent.keyDown(firstMenuItem, { key: "Escape" });
    expect(
      screen.queryByRole("menuitem", { name: "여러 페이지 선택…" }),
    ).toBeNull();
    const enabledTrigger = screen.getByRole("button", {
      name: "자동 지우기 추가 작업",
    });
    expect(document.activeElement).toBe(enabledTrigger);

    fireEvent.click(enabledTrigger);
    expect(
      screen.getByRole("menuitem", { name: "여러 페이지 선택…" }),
    ).not.toBeNull();

    view.rerender(<AppRightRail {...props} jobActive={true} />);

    expect(
      screen.queryByRole("menuitem", { name: "여러 페이지 선택…" }),
    ).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "자동 지우기 추가 작업",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(
      screen.queryByRole("menuitem", { name: "여러 페이지 선택…" }),
    ).toBeNull();
    expect(props.onOpenAutoInpaintingOptions).not.toHaveBeenCalled();
    expect(props.onShowGuide).not.toHaveBeenCalled();
  });

  it("disables current-page automatic erase without a selected page", () => {
    const props = makeRightRailProps({ selectedPage: null });
    renderRightRail(props);

    const currentPage = screen.getByRole("button", {
      name: "현재 페이지 자동 지우기",
    }) as HTMLButtonElement;
    expect(currentPage.disabled).toBe(true);
    fireEvent.click(currentPage);
    expect(props.onRunCurrentPageInpainting).not.toHaveBeenCalled();
  });

  it("uses manual tool, editor, then status priority without an auto mode", () => {
    const view = renderRightRail(
      makeRightRailProps({
        selectedBlock: makeBlock(),
        stageTool: "brush",
      }),
    );
    expect(screen.getByRole("heading", { name: "보정 설정" })).not.toBeNull();
    expect(document.querySelector(".editor-panel")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "되돌리기 (Ctrl+Z)" }),
    ).toBeNull();

    view.rerender(
      <AppRightRail
        {...makeRightRailProps({
          selectedBlock: makeBlock(),
          stageTool: "select",
        })}
      />,
    );
    expect(document.querySelector(".editor-panel.has-block")).not.toBeNull();

    view.rerender(<AppRightRail {...makeRightRailProps()} />);
    expect(screen.getByRole("heading", { name: "상태" })).not.toBeNull();
  });

  it("keeps the raw job failure visible while the block editor replaces status", () => {
    const rawFailure =
      "HIP runtime initialization failed: GPU architecture gfx1201 is unsupported";
    const props = makeRightRailProps({
      jobState: {
        id: "job-ocr-running",
        kind: "gemma-analysis",
        status: "running",
        progressText: "OCR 실행 중",
      },
      progressSnapshot: {
        mode: "determinate",
        current: 1,
        total: 3,
        ratio: 1 / 3,
      },
      selectedBlock: makeBlock(),
      showProgressBar: true,
    });
    const view = renderRightRail(props);

    expect(document.querySelector(".progress-card")).not.toBeNull();
    view.rerender(
      <AppRightRail
        {...props}
        jobState={{
          id: "job-ocr-failed",
          kind: "gemma-analysis",
          status: "failed",
          progressText: "OCR GPU 실행 실패",
          detail: rawFailure,
        }}
      />,
    );

    expect(document.querySelector(".editor-panel.has-block")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "상태" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "OCR GPU 실행 실패",
    );
    expect(screen.getByRole("alert").textContent).toContain(rawFailure);
    expect(document.querySelector(".progress-card")).toBeNull();
  });

  it("keeps the raw job failure visible without a progress snapshot", () => {
    const rawFailure = "Paddle OCR process exited with code 3221225781";
    renderRightRail(
      makeRightRailProps({
        jobState: {
          id: "job-ocr-failed-no-progress",
          kind: "gemma-analysis",
          status: "failed",
          progressText: "OCR 실패",
          detail: rawFailure,
        },
        progressSnapshot: null,
        selectedBlock: makeBlock(),
        showProgressBar: false,
      }),
    );

    expect(document.querySelector(".editor-panel.has-block")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(rawFailure);
  });
});

describe("persistent library sidebar", () => {
  it("keeps the library tree and page list mounted", () => {
    render(
      <AppSidebar
        currentChapter={makeChapter()}
        jobActive={false}
        library={{ workOrder: [], works: [] }}
        onOpenBatchImport={() => undefined}
        onOpenChapter={() => undefined}
        onOpenLibraryFolder={() => undefined}
        onOpenSettings={() => undefined}
        onOpenShareExport={() => undefined}
        onOpenShareImport={() => undefined}
        onOpenTranslationSource={() => undefined}
        onRemovePage={() => undefined}
        onRenameChapter={() => undefined}
        onRenameWork={() => undefined}
        onReorderChapter={() => undefined}
        onReorderPage={() => undefined}
        onRetranslatePage={() => undefined}
        onSelectPage={() => undefined}
        selectedPageId={null}
        settingsBusy={false}
        settingsOpen={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "보관함" })).not.toBeNull();
    expect(screen.getByText("page-1.png")).not.toBeNull();
    expect(screen.queryByText("인페인팅 나가기")).toBeNull();
  });
});

type RightRailProps = React.ComponentProps<typeof AppRightRail>;

function renderRightRail(props: RightRailProps) {
  return render(<AppRightRail {...props} />, {
    wrapper: RightRailTestProviders,
  });
}

function RightRailTestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const baseOptions = getBaseBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG);
  const options = getBlockFontOptions(DEFAULT_BLOCK_FONT_CATALOG);
  const panelSession: PanelSessionValue = {
    areaTranslateAvailable: false,
    areaTranslateSelecting: false,
    disableChapterApply: false,
    editorDisabled: false,
    editorFloating: false,
    editorPoppedOut: false,
    onAdjustFontSize: () => undefined,
    onApplyBlockBackgroundOpacity: () => undefined,
    onApplyFormat: () => undefined,
    onDeleteBlock: () => undefined,
    onDockEditorWindow: () => undefined,
    onDuplicateBlock: () => undefined,
    onPopOutEditor: () => undefined,
    onSelectTransformMode: () => undefined,
    onStartAreaTranslate: () => undefined,
    onToggleEditorFloat: () => undefined,
    onUpdateBlock: () => undefined,
    selectedBlock: makeBlock(),
    selectedBlockCount: 1,
    selectedPageSize: { width: 1000, height: 1600 },
    showDetachControls: false,
    transformMode: "select",
  };
  return (
    <FontsContext.Provider
      value={{
        baseOptions,
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        options,
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      <PanelSessionContext.Provider value={panelSession}>
        {children}
      </PanelSessionContext.Provider>
    </FontsContext.Provider>
  );
}

function makeRightRailProps(
  overrides: Partial<RightRailProps> = {},
): RightRailProps {
  return {
    brushColor: "#ffffff",
    brushRadius: 28,
    currentChapter: makeChapter(),
    flowActive: false,
    jobActive: false,
    jobState: {
      id: "",
      kind: "inpainting",
      progressText: "대기",
      status: "idle",
    },
    maskStrokeCount: 0,
    onBrushColorChange: vi.fn(),
    onBrushRadiusChange: vi.fn(),
    onCancelJob: vi.fn(),
    onClearPatternMask: vi.fn(),
    onOpenExport: vi.fn(),
    onOpenStyleGuide: vi.fn(),
    onOpenTextView: vi.fn(),
    onOpenTranslateOptions: vi.fn(),
    onRunDrawnPattern: vi.fn(),
    onRunCurrentPageInpainting: vi.fn(),
    onShowGuide: vi.fn(),
    onOpenAutoInpaintingOptions: vi.fn(),
    onToggleBlocks: vi.fn(),
    onToggleChrome: vi.fn(),
    progressSnapshot: null,
    selectedBlock: null,
    selectedPage: makePage(),
    showBlockChrome: true,
    showProgressBar: false,
    showTextBlocks: true,
    stageTool: "select",
    statusLines: [],
    ...overrides,
  };
}

function makeChapter(): ChapterSnapshot {
  const page = makePage();
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
