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
import { ControlTooltip } from "../src/renderer/src/components/ui/ControlTooltip";
import { SettingsNumberField } from "../src/renderer/src/components/settingsModal/SettingsNumberField";
import { InpaintingModelSettings } from "../src/renderer/src/components/settingsModal/InpaintingModelSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("contextual control help", () => {
  it("shows help by hover or focus outside clipping containers and dismisses without changing the input", () => {
    const change = vi.fn();
    const view = render(
      <div style={{ overflow: "hidden", height: 32 }}>
        <SettingsNumberField
          ariaLabel="Tokens"
          value="12"
          min={1}
          tooltip="Limit generated tokens"
          onValueChange={change}
        />
      </div>,
    );
    const input = screen.getByRole("textbox", { name: "Tokens" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    const trigger = input.parentElement;
    if (!trigger) throw new Error("Missing tooltip trigger");
    const bubble = screen.getByRole("tooltip", { hidden: true });
    expect(bubble.parentElement).toBe(document.body);
    expect(input.getAttribute("aria-describedby")).toBe(bubble.id);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(
      new DOMRect(900, 700, 100, 30),
    );
    vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 300, 120),
    );
    fireEvent.pointerEnter(trigger);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Limit generated tokens",
    );
    expect(bubble.style.top).toBe("572px");
    expect(bubble.style.left).toBe("712px");
    fireEvent.pointerLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(input);
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("tooltip")).toBe(bubble);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(input);
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(input);
    fireEvent.resize(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(change).not.toHaveBeenCalled();
    view.unmount();
    expect(document.getElementById(bubble.id)).toBeNull();
  });
  it("keeps existing descriptions and positions a button's help below when there is room", () => {
    render(
      <ControlTooltip floating content="Choose an image">
        <button aria-describedby="existing">Open</button>
      </ControlTooltip>,
    );
    const button = screen.getByRole("button", { name: "Open" });
    fireEvent.focus(button);
    const tip = screen.getByRole("tooltip");
    expect(button.getAttribute("aria-describedby")).toBe(`existing ${tip.id}`);
    expect(tip.style.top).toBe("12px");
    fireEvent.pointerDown(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("lets keyboard users read disabled control help without enabling its action", () => {
    const select = vi.fn();
    render(
      <ControlTooltip floating content="This option needs an SM75 GPU">
        <button disabled onClick={select}>
          SM75 CUDA
        </button>
      </ControlTooltip>,
    );
    const button = screen.getByRole("button", {
      name: "SM75 CUDA",
    }) as HTMLButtonElement;
    const anchor = button.parentElement;
    if (!anchor) throw new Error("Missing disabled tooltip wrapper");
    expect(button.disabled).toBe(true);
    expect(anchor.tabIndex).toBe(0);
    fireEvent.focus(anchor);
    const tip = screen.getByRole("tooltip");
    expect(anchor.getAttribute("aria-describedby")).toBe(tip.id);
    act(() => anchor.focus());
    fireEvent.scroll(window);
    expect(screen.getByRole("tooltip")).toBe(tip);
    fireEvent.click(button);
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("preserves the original inline tooltip contract", () => {
    render(
      <ControlTooltip content="Inline help">
        <button aria-describedby="prior">Inline</button>
      </ControlTooltip>,
    );
    expect(
      screen.getByRole("button").getAttribute("aria-describedby"),
    ).toContain(screen.getByRole("tooltip").id);
    expect(
      screen.getByRole("button").getAttribute("aria-describedby"),
    ).toContain("prior");
  });
});

describe("inpainting model choices with help", () => {
  const base = {
    allowUnsafeLowMemoryFlux: false,
    clearTestState: vi.fn(),
    controlsBusy: false,
    inpaintingModel: "lama-manga" as const,
    setAllowUnsafeLowMemoryFlux: vi.fn(),
    setInpaintingModel: vi.fn(),
    unifiedMemoryMb: 8192,
    usesAppleHardware: true,
  };
  it("explains a model without selecting it and keeps the low-memory confirmation", () => {
    const setModel = vi.fn();
    const allow = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <InpaintingModelSettings
        {...base}
        setInpaintingModel={setModel}
        setAllowUnsafeLowMemoryFlux={allow}
      />,
    );
    const flux = screen.getByRole("button", { name: "Flux 풀로드" });
    fireEvent.focus(flux);
    expect(screen.getByRole("tooltip").textContent).not.toBe("");
    expect(setModel).not.toHaveBeenCalled();
    fireEvent.click(flux);
    expect(confirm).toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(flux);
    expect(allow).toHaveBeenCalledWith(true);
    expect(setModel).toHaveBeenCalledWith("flux-klein");
    fireEvent.click(screen.getByRole("button", { name: "AOT 최소" }));
    expect(allow).toHaveBeenCalledWith(false);
    expect(setModel).toHaveBeenCalledWith("aot-inpainting");
  });
  it("retains an explicit low-memory override and accepts a safe device without prompting", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const allow = vi.fn();
    const view = render(
      <InpaintingModelSettings
        {...base}
        inpaintingModel="flux-klein"
        setAllowUnsafeLowMemoryFlux={allow}
      />,
    );
    const toggle = screen.getByRole("checkbox");
    fireEvent.click(toggle);
    expect(allow).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(toggle);
    expect(allow).toHaveBeenCalledWith(true);
    view.rerender(
      <InpaintingModelSettings
        {...base}
        inpaintingModel="flux-klein"
        allowUnsafeLowMemoryFlux
        setAllowUnsafeLowMemoryFlux={allow}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(allow).toHaveBeenCalledWith(false);
    confirm.mockClear();
    view.rerender(
      <InpaintingModelSettings {...base} usesAppleHardware={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Flux 풀로드" }));
    expect(confirm).not.toHaveBeenCalled();
  });
});

it("supports described render functions and text-only inline help", () => {
  const view = render(
    <ControlTooltip content="Custom control help">
      {(id) => <input aria-label="Custom" aria-describedby={id} />}
    </ControlTooltip>,
  );
  expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBe(
    screen.getByRole("tooltip").id,
  );
  view.rerender(
    <ControlTooltip content="Text help">Plain label</ControlTooltip>,
  );
  expect(screen.getByText("Plain label")).toBeTruthy();
  expect(screen.getByRole("tooltip").textContent).toBe("Text help");
});
