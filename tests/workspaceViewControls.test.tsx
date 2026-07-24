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
    fireEvent.click(screen.getByRole("button", { name: "배율 초기화" }));
    expect(onResetZoom).toHaveBeenCalledOnce();
    expect(screen.getByText("400%")).not.toBeNull();
  });
});
