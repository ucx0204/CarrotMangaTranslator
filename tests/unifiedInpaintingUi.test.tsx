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

vi.mock("../src/renderer/src/panels/EditorPanelSlot", () => ({
  EditorPanelSlot: () => <section data-testid="editor-slot">editor</section>,
}));

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

    expect(screen.getAllByRole("button")).toHaveLength(9);
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
    render(<AppRightRail {...props} />);

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
    const view = render(<AppRightRail {...props} />);

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
    render(<AppRightRail {...props} />);

    const currentPage = screen.getByRole("button", {
      name: "현재 페이지 자동 지우기",
    }) as HTMLButtonElement;
    expect(currentPage.disabled).toBe(true);
    fireEvent.click(currentPage);
    expect(props.onRunCurrentPageInpainting).not.toHaveBeenCalled();
  });

  it("uses manual tool, editor, then status priority without an auto mode", () => {
    const view = render(
      <AppRightRail
        {...makeRightRailProps({
          selectedBlock: makeBlock(),
          stageTool: "brush",
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "보정 설정" })).not.toBeNull();
    expect(screen.queryByTestId("editor-slot")).toBeNull();
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
    expect(screen.getByTestId("editor-slot")).not.toBeNull();

    view.rerender(<AppRightRail {...makeRightRailProps()} />);
    expect(screen.getByRole("heading", { name: "상태" })).not.toBeNull();
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
