// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceViewControls } from "../src/renderer/src/components/WorkspaceViewControls";

afterEach(cleanup);

describe("WorkspaceViewControls", () => {
  it("offers each fit basis and forwards the selected mode", () => {
    const onChangeFitMode = vi.fn();
    render(
      <WorkspaceViewControls
        fitMode="contain"
        zoom={1}
        onChangeFitMode={onChangeFitMode}
        onResetZoom={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
      />,
    );

    const select = screen.getByLabelText("이미지 맞춤 방식");
    expect(
      Array.from((select as HTMLSelectElement).options).map(
        (option) => option.text,
      ),
    ).toEqual(["화면 맞춤", "가로 맞춤", "세로 맞춤", "100%"]);

    fireEvent.change(select, { target: { value: "width" } });
    expect(onChangeFitMode).toHaveBeenCalledWith("width");
  });

  it("provides compact zoom controls and disables reached bounds", () => {
    const onResetZoom = vi.fn();
    const onZoomIn = vi.fn();
    render(
      <WorkspaceViewControls
        fitMode="actual"
        zoom={4}
        onChangeFitMode={() => undefined}
        onResetZoom={onResetZoom}
        onZoomIn={onZoomIn}
        onZoomOut={() => undefined}
      />,
    );

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

  it("collapses to an accessible reveal control without losing zoom or fit controls", () => {
    render(
      <WorkspaceViewControls
        fitMode="contain"
        zoom={1}
        onChangeFitMode={() => undefined}
        onResetZoom={() => undefined}
        onZoomIn={() => undefined}
        onZoomOut={() => undefined}
      />,
    );

    const collapseButton = screen.getByRole("button", {
      name: "보기 조절 접기",
    });
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "축소" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "확대" })).not.toBeNull();
    expect(screen.getByLabelText("이미지 맞춤 방식")).not.toBeNull();

    fireEvent.click(collapseButton);

    const revealButton = screen.getByRole("button", {
      name: "보기 조절 펼치기",
    });
    expect(revealButton.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(revealButton);
    expect(
      document.getElementById(revealButton.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "축소" })).toBeNull();
    expect(screen.queryByRole("button", { name: "확대" })).toBeNull();
    expect(
      screen
        .getByLabelText("이미지 맞춤 방식")
        .closest("nav")
        ?.hasAttribute("hidden"),
    ).toBe(true);

    fireEvent.click(revealButton);

    const restoredCollapseButton = screen.getByRole("button", {
      name: "보기 조절 접기",
    });
    expect(restoredCollapseButton.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(restoredCollapseButton);
    expect(
      screen.getByRole("button", { name: "배율 초기화" }).textContent,
    ).toBe("100%");
    expect(
      (screen.getByLabelText("이미지 맞춤 방식") as HTMLSelectElement).value,
    ).toBe("contain");
  });
});
