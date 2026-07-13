/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { AppRightRail } from "../src/renderer/src/components/AppRightRail";
import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import { StageToolbar } from "../src/renderer/src/components/StageToolbar";

vi.mock("../src/renderer/src/panels/EditorPanelSlot", () => ({
  EditorPanelSlot: () => <section data-testid="editor-slot">editor</section>,
}));

afterEach(() => cleanup());

describe("unified workspace toolbar", () => {
  it("renders one mutually-exclusive toolbar for translation and retouch tools", () => {
    const onSelectTool = vi.fn();
    render(
      <StageToolbar
        brushColor="#fa8128"
        brushRadius={28}
        disabled={false}
        hidden={false}
        onSelectTool={onSelectTool}
        onToggleHidden={() => undefined}
        tool="brush"
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(8);
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
  });

  it("disables every interaction tool while a job owns the canvas", () => {
    render(
      <StageToolbar
        brushColor="#ffffff"
        brushRadius={20}
        disabled={true}
        hidden={false}
        onSelectTool={() => undefined}
        onToggleHidden={() => undefined}
        tool="select"
      />,
    );

    for (const name of [
      "선택",
      "블록",
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
  it("always exposes translation, automatic erase, and PNG export", () => {
    const props = makeRightRailProps();
    render(<AppRightRail {...props} />);

    expect(
      (screen.getByRole("button", { name: "번역" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "자동 지우기" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "PNG 출력" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "PNG 출력" }));
    expect(props.onOpenExport).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "자동 지우기" }));
    expect(props.onOpenAutoInpaintingOptions).toHaveBeenCalledOnce();
  });

  it("uses manual tool, automatic erase, editor, then status priority", () => {
    const view = render(
      <AppRightRail
        {...makeRightRailProps({
          autoInpaintingOpen: true,
          selectedBlock: makeBlock(),
          stageTool: "brush",
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "보정 설정" })).not.toBeNull();
    expect(screen.queryByTestId("editor-slot")).toBeNull();

    view.rerender(
      <AppRightRail
        {...makeRightRailProps({
          autoInpaintingOpen: true,
          selectedBlock: makeBlock(),
          stageTool: "select",
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "자동 지우기" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "남은 페이지" })).toBeNull();
    expect(screen.queryByTestId("editor-slot")).toBeNull();

    view.rerender(
      <AppRightRail
        {...makeRightRailProps({
          autoInpaintingOpen: false,
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
    autoInpaintingOpen: false,
    brushColor: "#ffffff",
    brushRadius: 28,
    canRedoRetouch: false,
    canUndoRetouch: false,
    currentChapter: makeChapter(),
    flowActive: false,
    inpaintedPageCount: 0,
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
    onPeekToggle: vi.fn(),
    onRedoRetouch: vi.fn(),
    onRevertChapter: vi.fn(),
    onRevertPage: vi.fn(),
    onRunDrawnPattern: vi.fn(),
    onShowGuide: vi.fn(),
    onOpenAutoInpaintingOptions: vi.fn(),
    onToggleBlocks: vi.fn(),
    onToggleChrome: vi.fn(),
    onUndoRetouch: vi.fn(),
    pageTargetCount: 1,
    peekAvailable: false,
    peeking: false,
    pendingPageCount: 1,
    pendingTargetCount: 1,
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
