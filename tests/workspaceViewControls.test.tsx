// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewControls } from "../src/renderer/src/components/WorkspaceViewControls";
import {
  chooseCustomSelectOption,
  customSelectOptionValues,
  openCustomSelect,
} from "./testUtils/customSelect";

afterEach(cleanup);

describe("WorkspaceViewControls", () => {
  it("offers each fit basis and forwards the selected mode", () => {
    const onChangeFitMode = vi.fn();
    render(
      <WorkspaceViewControls
        effectiveScale={0.625}
        fitMode="contain"
        zoom={1}
        onChangeFitMode={onChangeFitMode}
        onResetZoom={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
      />,
    );
    expandViewControls();

    expect(customSelectOptionValues("이미지 맞춤 방식")).toEqual([
      "contain",
      "width",
      "height",
      "actual",
    ]);
    expect(
      within(screen.getByRole("listbox", { name: "이미지 맞춤 방식" }))
        .getByRole("option", { name: "원본 크기 (100%)", hidden: true }),
    ).not.toBeNull();
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "이미지 맞춤 방식" }),
      { key: "Escape" },
    );
    chooseCustomSelectOption("이미지 맞춤 방식", "가로 맞춤");
    expect(onChangeFitMode).toHaveBeenCalledWith("width");
  });

  it("provides compact zoom controls and disables reached bounds", () => {
    const onResetZoom = vi.fn();
    const onZoomIn = vi.fn();
    render(
      <WorkspaceViewControls
        effectiveScale={4}
        fitMode="actual"
        zoom={4}
        onChangeFitMode={() => undefined}
        onResetZoom={onResetZoom}
        onZoomIn={onZoomIn}
        onZoomOut={() => undefined}
      />,
    );
    expandViewControls();

    expect(
      (screen.getByRole("button", { name: "확대" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const resetButton = screen.getByRole("button", {
      name: "배율 초기화",
    });
    fireEvent.click(resetButton);
    expect(onResetZoom).toHaveBeenCalledOnce();
    expect(resetButton.textContent).toBe("400%");
  });

  it("marks manual zoom as custom and reapplies the current fit preset", () => {
    const onChangeFitMode = vi.fn();
    render(
      <WorkspaceViewControls
        effectiveScale={1.14}
        fitMode="contain"
        zoom={1.25}
        onChangeFitMode={onChangeFitMode}
        onResetZoom={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
      />,
    );
    expandViewControls();

    expect(
      screen.getByRole("tooltip", {
        name: "이미지 맞춤 방식: 사용자 배율 (114%)",
      }),
    ).not.toBeNull();
    chooseCustomSelectOption("이미지 맞춤 방식", "화면 맞춤");
    expect(onChangeFitMode).toHaveBeenCalledWith("contain");
  });

  it("opens leftward controls and dismisses them on focus loss, outside pointer, or Escape", () => {
    render(
      <WorkspaceViewControls
        effectiveScale={0.625}
        fitMode="contain"
        zoom={1}
        onChangeFitMode={() => undefined}
        onResetZoom={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
      />,
    );

    const revealButton = screen.getByRole("button", {
      name: "보기 조절 펼치기",
    });
    expect(revealButton.textContent).toContain("63%");
    expect(revealButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(revealButton);

    const openTrigger = screen.getByRole("button", {
      name: "보기 조절 접기",
    });
    expect(openTrigger).toBe(revealButton);
    expect(openTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "축소" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "확대" })).not.toBeNull();
    expect(screen.getByLabelText("이미지 맞춤 방식")).not.toBeNull();

    const outsideButton = document.createElement("button");
    outsideButton.textContent = "외부 버튼";
    document.body.append(outsideButton);
    outsideButton.focus();
    fireEvent.focusIn(outsideButton);

    const restoredRevealButton = screen.getByRole("button", {
      name: "보기 조절 펼치기",
    });
    expect(restoredRevealButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "축소" })).toBeNull();
    expect(screen.queryByRole("button", { name: "확대" })).toBeNull();

    fireEvent.click(restoredRevealButton);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: "축소" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "보기 조절 펼치기" }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    const escapedTrigger = screen.getByRole("button", {
      name: "보기 조절 펼치기",
    });
    expect(document.activeElement).toBe(escapedTrigger);

    fireEvent.click(escapedTrigger);
    expect(
      screen.getByRole("button", { name: "배율 초기화" }).textContent,
    ).toBe("63%");
    expect(
      (screen.getByLabelText("이미지 맞춤 방식") as HTMLButtonElement).value,
    ).toBe("contain");
    outsideButton.remove();
  });

  it("keeps portal fit choices interactive and closes the flyout on window blur", () => {
    render(
      <WorkspaceViewControls
        effectiveScale={0.79}
        fitMode="contain"
        zoom={1}
        onChangeFitMode={() => undefined}
        onResetZoom={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
      />,
    );
    expandViewControls();

    const listbox = openCustomSelect("이미지 맞춤 방식");
    fireEvent.pointerDown(
      within(listbox).getByRole("option", { name: "화면 맞춤", hidden: true }),
    );
    expect(
      screen.getByRole("button", { name: "보기 조절 접기" }),
    ).not.toBeNull();

    fireEvent.keyDown(window, { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "보기 조절 접기" }),
    ).not.toBeNull();

    fireEvent.blur(window);
    expect(
      screen.getByRole("button", { name: "보기 조절 펼치기" }),
    ).not.toBeNull();
  });
});

function expandViewControls(): void {
  fireEvent.click(screen.getByRole("button", { name: "보기 조절 펼치기" }));
}
