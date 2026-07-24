/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SelectionCard,
  SelectionSurface,
} from "../src/renderer/src/components/ui/SelectionCard";

afterEach(cleanup);

describe("SelectionCard", () => {
  it("keeps the whole labelled card clickable and derives visuals from checked", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <SelectionCard inputType="checkbox" checked={false} onChange={onChange}>
        <span>선택 항목</span>
      </SelectionCard>,
    );

    fireEvent.click(screen.getByText("선택 항목"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(
      container
        .querySelector(".selection-surface")
        ?.getAttribute("data-selected"),
    ).toBe("false");

    rerender(
      <SelectionCard inputType="checkbox" checked onChange={onChange}>
        <span>선택 항목</span>
      </SelectionCard>,
    );
    expect(
      container
        .querySelector(".selection-surface")
        ?.getAttribute("data-selected"),
    ).toBe("true");
  });

  it("supports grouped radio cards and disabled state", () => {
    const onChange = vi.fn();
    render(
      <SelectionCard
        inputType="radio"
        name="target"
        checked={false}
        disabled
        onChange={onChange}
      >
        기존 작품
      </SelectionCard>,
    );

    const radio = screen.getByRole("radio", { name: "기존 작품" });
    expect((radio as HTMLInputElement).name).toBe("target");
    expect((radio as HTMLInputElement).disabled).toBe(true);
    expect(
      radio.closest(".selection-surface")?.getAttribute("data-disabled"),
    ).toBe("true");
  });
});

describe("SelectionSurface", () => {
  it("supports composite and button selection surfaces", () => {
    const onClick = vi.fn();
    render(
      <SelectionSurface
        as="button"
        selected
        aria-pressed="true"
        onClick={onClick}
      >
        이 페이지
      </SelectionSurface>,
    );

    fireEvent.click(screen.getByRole("button", { name: "이 페이지" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "이 페이지" })
        .getAttribute("data-selected"),
    ).toBe("true");
  });
});
