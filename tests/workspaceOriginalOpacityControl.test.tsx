// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceOriginalOpacityControl } from "../src/renderer/src/components/WorkspaceOriginalOpacityControl";

afterEach(cleanup);

describe("WorkspaceOriginalOpacityControl", () => {
  it("stays disabled until separate original and inpainted images are available", () => {
    render(
      <WorkspaceOriginalOpacityControl
        available={false}
        opacity={0}
        pageId="page-1"
        onChange={() => undefined}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "원본 불투명도 조절 열기",
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("group")).toBeNull();
    expect(
      screen.getByRole("tooltip", {
        name: "인페인트 결과가 있는 페이지에서 원본 불투명도를 조절할 수 있습니다.",
      }),
    ).not.toBeNull();
  });

  it("keeps the same dock icon mounted while supported frames finish loading", () => {
    const view = render(
      <WorkspaceOriginalOpacityControl
        available={false}
        supported
        opacity={0}
        pageId="page-1"
        onChange={() => undefined}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "원본 불투명도 조절 열기",
    }) as HTMLButtonElement;
    const icon = trigger.querySelector("svg");
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(
      trigger.closest(".workspace-original-opacity-dock")?.className,
    ).toContain("pending");
    expect(
      screen.getByRole("tooltip", { name: "이미지 불러오는 중" }),
    ).not.toBeNull();

    view.rerender(
      <WorkspaceOriginalOpacityControl
        available
        supported
        opacity={0}
        pageId="page-1"
        onChange={() => undefined}
      />,
    );

    const readyTrigger = screen.getByRole("button", {
      name: "원본 불투명도 조절 열기",
    });
    expect(readyTrigger).toBe(trigger);
    expect(readyTrigger.querySelector("svg")).toBe(icon);
    expect(readyTrigger.getAttribute("aria-busy")).toBeNull();
  });

  it("opens a focused one-percent gauge and forwards normalized opacity", () => {
    const onChange = vi.fn();
    render(
      <WorkspaceOriginalOpacityControl
        available
        opacity={0.42}
        pageId="page-1"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "원본 불투명도 조절 열기",
    });
    fireEvent.click(trigger);
    const slider = screen.getByRole("slider", {
      name: "원본 이미지 불투명도",
    }) as HTMLInputElement;
    expect(document.activeElement).toBe(slider);
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.step).toBe("1");
    expect(slider.value).toBe("42");
    expect(screen.getByText("42%")).not.toBeNull();

    fireEvent.change(slider, { target: { value: "67" } });
    expect(onChange).toHaveBeenCalledWith(0.67);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on focus loss and when the selected page changes", () => {
    const view = render(
      <WorkspaceOriginalOpacityControl
        available
        opacity={0.2}
        pageId="page-1"
        onChange={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "원본 불투명도 조절 열기" }),
    );
    expect(screen.getByRole("slider")).not.toBeNull();

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    fireEvent.focusIn(outside);
    expect(screen.queryByRole("slider")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "원본 불투명도 조절 열기" }),
    );
    view.rerender(
      <WorkspaceOriginalOpacityControl
        available
        opacity={0.6}
        pageId="page-2"
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByRole("slider")).toBeNull();
    outside.remove();
  });
});
