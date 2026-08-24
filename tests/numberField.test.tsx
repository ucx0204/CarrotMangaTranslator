/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberField } from "../src/renderer/src/components/ui/NumberField";

afterEach(cleanup);

describe("NumberField", () => {
  it("applies valid live values but restores incomplete input", () => {
    const onValueChange = vi.fn();
    render(<NumberHarness commitMode="change" onValueChange={onValueChange} />);
    const input = screen.getByRole("spinbutton", { name: "크기" });
    fireEvent.change(input, { target: { value: "42" } });
    expect(onValueChange).toHaveBeenLastCalledWith(42);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).valueAsNumber).toBe(42);
  });

  it("clamps blur commits and restores the prior value on Escape", () => {
    const onValueChange = vi.fn();
    render(<NumberHarness commitMode="blur" onValueChange={onValueChange} />);
    const input = screen.getByRole("spinbutton", { name: "크기" });
    fireEvent.change(input, { target: { value: "500" } });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenLastCalledWith(100);
    expect((input as HTMLInputElement).valueAsNumber).toBe(100);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "13" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).valueAsNumber).toBe(100);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("shows a mixed placeholder until a concrete value is entered", () => {
    const onValueChange = vi.fn();
    render(
      <NumberField
        ariaLabel="혼합 크기"
        value={24}
        min={10}
        max={100}
        mixed
        commitMode="change"
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "혼합 크기" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("—");
    fireEvent.change(input, { target: { value: "30" } });
    expect(onValueChange).toHaveBeenCalledWith(30);
  });

  it("snaps direct blur commits to the requested step", () => {
    const onValueChange = vi.fn();
    render(
      <NumberField
        ariaLabel="외곽선"
        value={1.5}
        min={0}
        max={64}
        step={0.5}
        precision={1}
        snapToStep
        commitMode="blur"
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "외곽선" });
    fireEvent.change(input, { target: { value: "8.3" } });
    fireEvent.blur(input);

    expect(onValueChange).toHaveBeenCalledWith(8.5);
    expect((input as HTMLInputElement).valueAsNumber).toBe(8.5);
  });

  it("derives display precision from a fractional step", () => {
    render(
      <NumberField
        ariaLabel="Temperature"
        value={0.7}
        min={0}
        max={2}
        step={0.05}
        onValueChange={() => undefined}
      />,
    );

    expect(
      (
        screen.getByRole("spinbutton", {
          name: "Temperature",
        }) as HTMLInputElement
      ).value,
    ).toBe("0.7");
  });

  it("uses the whole value zone as the edit target for short values", () => {
    const { container } = render(
      <NumberField
        ariaLabel="짧은 값"
        value={1}
        min={0}
        max={9}
        unit="px"
        variant="framed"
        onValueChange={() => undefined}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "짧은 값" });
    const editZone = container.querySelector("[data-ui-number-input-zone]");

    expect(editZone).not.toBeNull();
    if (!editZone) throw new Error("Number field edit zone was not rendered");
    fireEvent.pointerDown(editZone);
    expect(document.activeElement).toBe(input);
  });

  it("can use a stepper-free text input while rejecting non-numeric drafts", () => {
    const onValueChange = vi.fn();
    render(
      <NumberField
        ariaLabel="글자 크기"
        value={12}
        min={1}
        max={512}
        step={0.5}
        precision={1}
        useTextInput
        onValueChange={onValueChange}
      />,
    );
    const input = screen.getByRole("textbox", { name: "글자 크기" });
    expect(input.getAttribute("type")).toBe("text");

    fireEvent.change(input, { target: { value: "12px" } });
    expect((input as HTMLInputElement).value).toBe("12");
    fireEvent.change(input, { target: { value: "12.5" } });
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenCalledWith(12.5);
  });
});

function NumberHarness({
  commitMode,
  onValueChange,
}: {
  commitMode: "change" | "blur";
  onValueChange: (value: number) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState(24);
  return (
    <NumberField
      ariaLabel="크기"
      value={value}
      min={10}
      max={100}
      commitMode={commitMode}
      onValueChange={(next) => {
        onValueChange(next);
        setValue(next);
      }}
    />
  );
}
