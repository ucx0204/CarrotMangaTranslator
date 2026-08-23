/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { AppRightQuickRail } from "../src/renderer/src/components/AppRightQuickRail";
import { AppRightRail } from "../src/renderer/src/components/AppRightRail";
import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("unified workspace toolbar", () => {
  it("keeps the collapsed toolbar available as a compact restore control", () => {
    const onToggleHidden = vi.fn();
    render(
      <StageToolbar
        brushColor="#ffffff"
        disabled={false}
        hidden
        lastRetouchTool="brush"
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={onToggleHidden}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "도구 모음 표시 (4)" }));
    expect(onToggleHidden).toHaveBeenCalledOnce();
  });

  it("renders one mutually-exclusive toolbar for translation and retouch tools", () => {
    const onSelectTool = vi.fn();
    const onToggleRegionTranslation = vi.fn();
    const { container } = render(
      <StageToolbar
        bubbleLayoutAvailable
        brushColor="#fa8128"
        disabled={false}
        hidden={false}
        lastRetouchTool="brush"
        onSelectTool={onSelectTool}
        onToggleRegionTranslation={onToggleRegionTranslation}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="brush"
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(9);
    const groupTriggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".stage-toolbar-group-trigger",
      ),
    );
    expect(groupTriggers).toHaveLength(2);
    expect(groupTriggers[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(groupTriggers[0]?.dataset.activeTool).toBe("brush");
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-stage-toolbar-section]"),
      ).map((section) => section.dataset.stageToolbarSection),
    ).toEqual(["primary", "layout", "retouch", "collapse"]);
    expect(container.querySelectorAll("[data-stage-tool-swatch]")).toHaveLength(
      1,
    );
    expect(
      container.querySelector('[data-stage-tool-group="text-shape"]'),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "원근" })).toBeNull();
    expect(screen.queryByRole("button", { name: "곡선" })).toBeNull();
    expect(screen.getByRole("button", { name: "말풍선 영역" })).toBeTruthy();

    fireEvent.pointerEnter(screen.getByRole("button", { name: "칠하기 도구" }));
    const brush = screen.getByRole("menuitemradio", { name: "브러시" });
    expect(
      screen.queryByRole("tooltip", {
        name: "브러시·도형·색 추출 도구",
      }),
    ).toBeNull();
    expect(brush.getAttribute("aria-checked")).toBe("true");
    expect(brush.textContent).toContain("브러시");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("tooltip", { name: "보정 브러시" })).toBeTruthy();
    expect(brush.hasAttribute("title")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "마스크" }));
    expect(onSelectTool).toHaveBeenCalledWith("mask");

    fireEvent.click(screen.getByRole("button", { name: "말풍선 영역" }));
    expect(onSelectTool).toHaveBeenCalledWith("bubble");

    fireEvent.click(screen.getByRole("button", { name: "영역 번역" }));
    expect(onToggleRegionTranslation).toHaveBeenCalledOnce();
  });

  it("activates the remembered retouch tool directly from the group button", () => {
    const onSelectTool = vi.fn();
    const { container } = render(
      <StageToolbar
        bubbleLayoutAvailable
        brushColor="#ffffff"
        disabled={false}
        hidden={false}
        lastRetouchTool="ellipse"
        onSelectTool={onSelectTool}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="hand"
      />,
    );
    const retouch = container.querySelector<HTMLButtonElement>(
      '[data-stage-tool-group="paint"]',
    );

    expect(retouch?.dataset.activeTool).toBeUndefined();
    expect(retouch?.dataset.selectedTool).toBe("ellipse");
    expect(retouch?.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(retouch as HTMLButtonElement);

    expect(onSelectTool).toHaveBeenCalledOnce();
    expect(onSelectTool).toHaveBeenCalledWith("ellipse");
    expect(
      screen
        .getByRole("menuitemradio", { name: "원형" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("separates paint and restore tools and exposes rectangle restore", () => {
    const onSelectTool = vi.fn();
    render(
      <StageToolbar
        bubbleLayoutAvailable
        brushColor="#ffffff"
        disabled={false}
        hidden={false}
        lastRetouchTool="eraser"
        onSelectTool={onSelectTool}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="eraser"
      />,
    );

    fireEvent.pointerEnter(screen.getByRole("button", { name: "복원 도구" }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "사각 지우개" }));
    expect(onSelectTool).toHaveBeenCalledWith("eraser-rectangle");
  });

  it("opens retouch tools on hover and keeps the pointer gap stable", () => {
    vi.useFakeTimers();
    const { container } = render(
      <StageToolbar
        bubbleLayoutAvailable
        brushColor="#ffffff"
        disabled={false}
        hidden={false}
        lastRetouchTool="brush"
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );
    const retouch = container.querySelector<HTMLButtonElement>(
      '[data-stage-tool-group="paint"]',
    );
    const group = retouch?.closest(".stage-toolbar-group-control");
    fireEvent.pointerEnter(retouch as HTMLButtonElement);
    const menu = screen.getByRole("menu");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(4);

    fireEvent.pointerLeave(group as HTMLElement);
    fireEvent.pointerEnter(menu);
    vi.advanceTimersByTime(200);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.pointerLeave(group as HTMLElement);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("supports keyboard focus, Escape, and outside interaction", () => {
    const { container } = render(
      <StageToolbar
        bubbleLayoutAvailable
        brushColor="#ffffff"
        disabled={false}
        hidden={false}
        lastRetouchTool="brush"
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );
    const retouch = container.querySelector<HTMLButtonElement>(
      '[data-stage-tool-group="paint"]',
    );
    fireEvent.focus(retouch as HTMLButtonElement);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(retouch as HTMLButtonElement, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.pointerEnter(retouch as HTMLButtonElement);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(retouch as HTMLButtonElement);
    const firstItem = screen.getByRole("menuitemradio", { name: "브러시" });
    expect(document.activeElement).toBe(firstItem);
    fireEvent.keyDown(firstItem, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(retouch);

    fireEvent.pointerEnter(retouch as HTMLButtonElement);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps unavailable bubble editing disabled as a direct tool", () => {
    render(
      <StageToolbar
        brushColor="#ffffff"
        disabled={false}
        hidden={false}
        lastRetouchTool="brush"
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "말풍선 영역",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps region translation visible and exposes its active state", () => {
    render(
      <StageToolbar
        brushColor="#ffffff"
        disabled={false}
        hidden={false}
        lastRetouchTool="brush"
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
        disabled={false}
        hidden={false}
        lastRetouchTool="brush"
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
        disabled={true}
        hidden={false}
        lastRetouchTool="brush"
        onSelectTool={() => undefined}
        onToggleRegionTranslation={() => undefined}
        onToggleHidden={() => undefined}
        regionTranslationActive={false}
        regionTranslationAvailable={true}
        tool="select"
      />,
    );

    for (const name of ["선택", "블록", "영역 번역", "손바닥", "말풍선 영역"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    for (const trigger of document.querySelectorAll<HTMLButtonElement>(
      ".stage-toolbar-group-trigger",
    )) {
      expect(trigger.disabled).toBe(true);
    }
  });
});

describe("unified right rail", () => {
  it("keeps all page quick actions in one icon toolbar off the canvas", () => {
    const props = makeRightRailProps({
      canRedo: false,
      showBlockChrome: false,
      showTextBlocks: true,
      undoLabel: "텍스트 편집",
    });
    renderQuickRail(props);

    const toolbar = screen.getByRole("toolbar", { name: "캔버스 작업" });
    const translations = screen.getByRole("button", {
      name: "번역문 표시",
    });
    const chrome = screen.getByRole("button", { name: "배경/테두리" });
    expect(translations.getAttribute("aria-pressed")).toBe("true");
    expect(chrome.getAttribute("aria-pressed")).toBe("false");
    expect(
      Array.from(toolbar.querySelectorAll("button")).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "텍스트 편집 실행 취소 (Ctrl+Z)",
      "다시 실행 (Ctrl+Y / Ctrl+Shift+Z)",
      "원본과 비교",
      "이 페이지를 원본 이미지로 초기화 (확인 후 실행)",
      "번역문 표시",
      "배경/테두리",
      "텍스트 모아보기",
      "용어/기억",
    ]);
    expect(toolbar.closest(".right-quick-rail")).not.toBeNull();
    expect(toolbar.closest(".right-rail")).toBeNull();
    expect(document.querySelector(".canvas-action-bar")).toBeNull();
    expect(
      Array.from(
        toolbar.querySelectorAll<HTMLElement>("[data-chapter-quick-group]"),
      ).map((group) => group.dataset.chapterQuickGroup),
    ).toEqual(["history", "original", "display", "documents"]);
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-right-quick-group]"),
      ).map((group) => group.dataset.rightQuickGroup),
    ).toEqual(["view", "original-opacity", "status"]);

    const undo = screen.getByRole("button", {
      name: "텍스트 편집 실행 취소 (Ctrl+Z)",
    });
    const redo = screen.getByRole("button", {
      name: "다시 실행 (Ctrl+Y / Ctrl+Shift+Z)",
    }) as HTMLButtonElement;
    const compare = screen.getByRole("button", { name: "원본과 비교" });
    const reset = screen.getByRole("button", {
      name: "이 페이지를 원본 이미지로 초기화 (확인 후 실행)",
    });
    expect(redo.disabled).toBe(true);
    expect(undo.hasAttribute("title")).toBe(false);
    expect(
      screen.getByRole("tooltip", {
        name: "텍스트 편집 실행 취소 (Ctrl+Z)",
      }),
    ).not.toBeNull();

    fireEvent.click(translations);
    fireEvent.click(chrome);
    fireEvent.click(undo);
    fireEvent.click(compare);
    fireEvent.click(reset);
    fireEvent.click(screen.getByRole("button", { name: "텍스트 모아보기" }));
    fireEvent.click(screen.getByRole("button", { name: "용어/기억" }));
    expect(props.onToggleBlocks).toHaveBeenCalledOnce();
    expect(props.onToggleChrome).toHaveBeenCalledOnce();
    expect(props.onUndo).toHaveBeenCalledOnce();
    expect(props.onPeekToggle).toHaveBeenCalledOnce();
    expect(props.onResetPage).toHaveBeenCalledOnce();
    expect(props.onOpenTextView).toHaveBeenCalledOnce();
    expect(props.onOpenStyleGuide).toHaveBeenCalledOnce();
  });

  it("keeps chapter utilities directly available without an overflow menu", () => {
    const props = makeRightRailProps();
    const { container } = renderQuickRail(props);
    fireEvent.click(screen.getByRole("button", { name: "텍스트 모아보기" }));
    expect(props.onOpenTextView).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "용어/기억" }));
    expect(props.onOpenStyleGuide).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("hides the upper and lower quick-tool groups independently", () => {
    const props = makeRightRailProps();
    renderQuickRail(props);

    expect(screen.getByRole("toolbar", { name: "캔버스 작업" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "보기 조절 펼치기" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "작업 센터 열기" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "원본 불투명도 조절 열기" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "위쪽 도구 숨기기" }));
    expect(screen.queryByRole("toolbar", { name: "캔버스 작업" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "보기 조절 펼치기" }),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "아래쪽 도구 숨기기" }));
    expect(
      screen.queryByRole("button", { name: "보기 조절 펼치기" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "작업 센터 열기" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "원본 불투명도 조절 열기" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "위쪽 도구 보이기" }));
    expect(screen.getByRole("toolbar", { name: "캔버스 작업" })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "보기 조절 펼치기" }),
    ).toBeNull();
  });

  it("offers current, whole-chapter, and selected-page erase scopes", () => {
    const props = makeRightRailProps();
    renderRightRail(props);

    expect(
      (screen.getByRole("button", { name: "번역 실행" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "현재 페이지 지우기",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "결과물 출력",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "결과물 출력" }));
    expect(props.onOpenExport).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menuitem", { name: "지울 페이지 선택" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "현재 페이지 지우기" }));
    expect(props.onRunCurrentPageInpainting).toHaveBeenCalledOnce();
    expect(props.onOpenAutoInpaintingOptions).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "자동 지우기 추가 작업" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "전체 페이지 지우기" }),
    );
    expect(props.onOpenAutoInpaintingOptions).toHaveBeenCalledWith("all");

    fireEvent.click(
      screen.getByRole("button", { name: "자동 지우기 추가 작업" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "지울 페이지 선택" }));
    expect(props.onOpenAutoInpaintingOptions).toHaveBeenLastCalledWith(
      "select",
    );
  });

  it("shows bubble detection as its own action and only requires text blocks", () => {
    const props = makeRightRailProps({ canRunBubbleLayout: true });
    const view = renderRightRail(props);
    const bubbleLayout = screen.getByRole("button", {
      name: "현재 페이지 말풍선 자동 감지",
    }) as HTMLButtonElement;

    expect(bubbleLayout.disabled).toBe(false);
    fireEvent.click(bubbleLayout);
    expect(props.onRunBubbleLayout).toHaveBeenCalledOnce();
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          ".current-page-actions button:not(.auto-inpainting-menu-trigger)",
        ),
      ).map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "현재 페이지 지우기",
      "현재 페이지 말풍선 자동 감지",
      "결과물 출력",
    ]);

    view.rerender(<AppRightRail {...props} canRunBubbleLayout={false} />);
    const disabledBubbleLayout = screen.getByRole("button", {
      name: "현재 페이지 말풍선 자동 감지",
    }) as HTMLButtonElement;
    expect(disabledBubbleLayout.disabled).toBe(true);
    expect(
      screen.getByRole("tooltip", {
        name: "먼저 현재 페이지를 지워 주세요.",
      }),
    ).not.toBeNull();
    expect(disabledBubbleLayout.hasAttribute("title")).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "자동 지우기 추가 작업" }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: "현재 페이지 말풍선 자동 감지",
      }),
    ).toBeNull();
  });

  it("closes and disables the automatic erase menu when work becomes busy", () => {
    const props = makeRightRailProps();
    const view = renderRightRail(props);

    fireEvent.click(
      screen.getByRole("button", { name: "자동 지우기 추가 작업" }),
    );
    const firstMenuItem = screen.getByRole("menuitem", {
      name: "전체 페이지 지우기",
    });
    expect(firstMenuItem).not.toBeNull();
    expect(document.activeElement).toBe(firstMenuItem);

    fireEvent.keyDown(firstMenuItem, { key: "Escape" });
    expect(
      screen.queryByRole("menuitem", { name: "전체 페이지 지우기" }),
    ).toBeNull();
    const enabledTrigger = screen.getByRole("button", {
      name: "자동 지우기 추가 작업",
    });
    expect(document.activeElement).toBe(enabledTrigger);

    fireEvent.click(enabledTrigger);
    expect(
      screen.getByRole("menuitem", { name: "전체 페이지 지우기" }),
    ).not.toBeNull();

    view.rerender(<AppRightRail {...props} jobActive={true} />);

    expect(
      screen.queryByRole("menuitem", { name: "전체 페이지 지우기" }),
    ).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "자동 지우기 추가 작업",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(
      screen.queryByRole("menuitem", { name: "전체 페이지 지우기" }),
    ).toBeNull();
    expect(props.onOpenAutoInpaintingOptions).not.toHaveBeenCalled();
  });

  it("hides current-page actions without a selected page", () => {
    const props = makeRightRailProps({ selectedPage: null });
    renderRightRail(props);

    expect(
      screen.queryByRole("button", {
        name: "현재 페이지 지우기",
      }),
    ).toBeNull();
    expect(props.onRunCurrentPageInpainting).not.toHaveBeenCalled();
  });

  it("uses manual tool, editor, then the page block list", () => {
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
    expect(screen.queryByRole("heading", { name: "상태" })).toBeNull();

    view.rerender(
      <AppRightRail
        {...makeRightRailProps({
          statusLines: ["완료한 작업이 있습니다."],
        })}
      />,
    );
    expect(screen.queryByRole("heading", { name: "상태" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "현재 페이지 블록" }),
    ).not.toBeNull();
  });

  it("does not keep completed work in the right rail", () => {
    renderRightRail(
      makeRightRailProps({
        jobState: {
          id: "job-completed",
          kind: "inpainting",
          status: "completed",
          progressText: "자동 지우기 완료",
        },
        progressSnapshot: {
          mode: "determinate",
          current: 3,
          total: 3,
          ratio: 1,
        },
        showProgressBar: true,
      }),
    );

    expect(document.querySelector(".progress-card")).toBeNull();
    expect(screen.queryByText("자동 지우기 완료")).toBeNull();
    expect(screen.queryByRole("heading", { name: "상태" })).toBeNull();
  });

  it("removes the progress card as soon as determinate progress reaches its total", () => {
    renderRightRail(
      makeRightRailProps({
        jobState: {
          id: "job-running-at-total",
          kind: "inpainting",
          status: "running",
          progressText: "자동 지우기 완료",
        },
        progressSnapshot: {
          mode: "determinate",
          current: 1,
          total: 1,
          ratio: 1,
        },
        showProgressBar: true,
      }),
    );

    expect(document.querySelector(".progress-card")).toBeNull();
    expect(screen.queryByText("자동 지우기 완료")).toBeNull();
  });

  it("shows an accessible full-width color row for every paint tool", () => {
    const props = makeRightRailProps({
      brushColor: "#fa8128",
      stageTool: "brush",
    });
    const view = renderRightRail(props);

    const brushColorInput = screen.getByLabelText(
      "붓 색상",
    ) as HTMLInputElement;
    expect(brushColorInput.type).toBe("color");
    expect(brushColorInput.value).toBe("#fa8128");
    expect(screen.getByText("#FA8128")).not.toBeNull();
    expect(document.querySelector(".brush-size-control")).not.toBeNull();
    expect(document.querySelector(".retouch-color-label")?.textContent).toBe(
      "색상",
    );
    expect(document.querySelector(".retouch-color-tool")).toBeNull();
    brushColorInput.focus();
    expect(document.activeElement).toBe(brushColorInput);

    fireEvent.change(brushColorInput, { target: { value: "#123456" } });
    expect(props.onBrushColorChange).toHaveBeenCalledWith("#123456");

    for (const [tool, label] of [
      ["rectangle", "사각형 색상"],
      ["ellipse", "원형 색상"],
    ] as const) {
      view.rerender(
        <AppRightRail
          {...makeRightRailProps({
            brushColor: "#abcdef",
            stageTool: tool,
          })}
        />,
      );

      const shapeColorInput = screen.getByLabelText(label) as HTMLInputElement;
      expect(shapeColorInput.type).toBe("color");
      expect(shapeColorInput.value).toBe("#abcdef");
      expect(screen.getByText("#ABCDEF")).not.toBeNull();
      expect(document.querySelector(".brush-size-control")).toBeNull();
    }
  });

  it("keeps the raw job failure visible in the activity center while the block editor replaces status", () => {
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
    const view = renderQuickRail(props);

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
    expect(document.querySelector(".progress-card")).not.toBeNull();
    view.rerender(
      <AppRightQuickRail
        {...props}
        {...makeQuickRailChromeProps()}
        jobState={{
          id: "job-ocr-failed",
          kind: "gemma-analysis",
          status: "failed",
          progressText: "OCR GPU 실행 실패",
          detail: rawFailure,
        }}
      />,
    );

    expect(screen.queryByRole("heading", { name: "상태" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "OCR GPU 실행 실패",
    );
    expect(screen.getByRole("alert").textContent).toContain(rawFailure);
    expect(document.querySelector(".progress-card")).toBeNull();
  });

  it("keeps the raw job failure visible in the activity center without a progress snapshot", () => {
    const rawFailure = "Paddle OCR process exited with code 3221225781";
    renderQuickRail(
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

    fireEvent.click(screen.getByRole("button", { name: "작업 센터 열기" }));
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

function renderQuickRail(props: RightRailProps) {
  return render(
    <AppRightQuickRail {...props} {...makeQuickRailChromeProps()} />,
    {
      wrapper: RightRailTestProviders,
    },
  );
}

function makeQuickRailChromeProps(): Pick<
  React.ComponentProps<typeof AppRightQuickRail>,
  "workspaceOriginalOpacityControl" | "workspaceViewControls"
> {
  return {
    workspaceOriginalOpacityControl: {
      available: true,
      opacity: 0,
      pageId: "page-1",
      onChange: () => undefined,
    },
    workspaceViewControls: {
      effectiveScale: 1,
      fitMode: "contain",
      zoom: 1,
      onChangeFitMode: () => undefined,
      onResetZoom: () => undefined,
      onZoomIn: () => undefined,
      onZoomOut: () => undefined,
    },
  };
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
    blockStylePresets: [],
    canCreateStylePreset: true,
    onAdjustFontSize: () => undefined,
    onApplyBlockBackgroundOpacity: () => undefined,
    onApplyFormat: () => undefined,
    onApplyStylePreset: () => undefined,
    onBackToPageBlocks: () => undefined,
    onCreateStylePreset: async () => true,
    onDeleteStylePreset: async () => true,
    onDeleteBlock: () => undefined,
    onDockEditorWindow: () => undefined,
    onDuplicateBlock: () => undefined,
    onInsertBlockLibraryEntry: () => undefined,
    onOpenBlockLibrary: () => undefined,
    onEraseBlockOriginal: () => undefined,
    onFitBlockBubble: () => undefined,
    onPopOutEditor: () => undefined,
    onRemoveBubbleLayout: () => undefined,
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
    blockReadingDirection: "rtl",
    brushColor: "#ffffff",
    brushRadius: 28,
    canRedo: true,
    canUndo: true,
    canRunBubbleLayout: false,
    compareAvailable: true,
    currentChapter: makeChapter(),
    editorDisabled: false,
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
    onClearStatusLines: vi.fn(),
    onClearPatternMask: vi.fn(),
    onOpenExport: vi.fn(),
    onOpenLogFolder: vi.fn(),
    onReviewResults: vi.fn(),
    onRetryPage: vi.fn(),
    onOpenStyleGuide: vi.fn(),
    onOpenTextView: vi.fn(),
    onOpenTranslateOptions: vi.fn(),
    onPeekToggle: vi.fn(),
    onRedo: vi.fn(),
    onResetPage: vi.fn(),
    onRunDrawnPattern: vi.fn(),
    onRunBubbleLayout: vi.fn(),
    onRunCurrentPageInpainting: vi.fn(),
    onRetrySave: vi.fn(),
    onOpenAutoInpaintingOptions: vi.fn(),
    onOpenBlockEditor: vi.fn(),
    onSelectBlock: vi.fn(),
    onToggleBlocks: vi.fn(),
    onToggleChrome: vi.fn(),
    onUndo: vi.fn(),
    onUpdateBlock: vi.fn(),
    peeking: false,
    progressSnapshot: null,
    selectedBlock: null,
    selectedBlockId: null,
    selectedPage: makePage(),
    resetAvailable: true,
    showBlockChrome: true,
    showProgressBar: false,
    showTextBlocks: true,
    stageTool: "select",
    statusLines: [],
    rightRailMode: "block-editor",
    saveStatus: "idle",
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
