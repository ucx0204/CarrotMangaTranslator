/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrubbableNumberField } from "../src/renderer/src/components/ui/ScrubbableNumberField";

afterEach(cleanup);

describe("ScrubbableNumberField", () => {
  it("commits direct input on Enter or blur and restores it on Escape", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "값" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "3.75" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(3.75);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "8.25" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(8.25);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "9.5" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("8.25");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("changes one step on click", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "값 늘리기" }));
    expect(onChange).toHaveBeenLastCalledWith(1.25);
    fireEvent.click(screen.getByRole("button", { name: "값 줄이기" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("scrubs across the range and suppresses the click after a drag", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const increase = screen.getByRole("button", { name: "값 늘리기" });

    fireEvent.pointerDown(increase, {
      button: 0,
      clientX: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(increase, { clientX: 260, pointerId: 1 });
    fireEvent.pointerUp(increase, { clientX: 260, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(6);

    fireEvent.click(increase);
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(increase);
    expect(onChange).toHaveBeenLastCalledWith(6.25);
  });

  it("keeps a sub-threshold pointer move as a normal click", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const increase = screen.getByRole("button", { name: "값 늘리기" });

    fireEvent.pointerDown(increase, {
      button: 0,
      clientX: 100,
      pointerId: 1,
    });
    fireEvent.pointerMove(increase, { clientX: 103, pointerId: 1 });
    fireEvent.pointerUp(increase, { clientX: 103, pointerId: 1 });
    fireEvent.click(increase);
    expect(onChange).toHaveBeenLastCalledWith(1.25);
  });
});

function Harness({
  onChange,
}: {
  onChange: (value: number) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState(1);
  return (
    <ScrubbableNumberField
      ariaLabel="값"
      decreaseLabel="값 줄이기"
      increaseLabel="값 늘리기"
      min={0}
      max={10}
      step={0.25}
      precision={2}
      value={value}
      onValueChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}
