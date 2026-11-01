/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "../src/renderer/src/components/ui/Button";
import { IconButton } from "../src/renderer/src/components/ui/IconButton";
import { ControlTooltip } from "../src/renderer/src/components/ui/ControlTooltip";

afterEach(cleanup);

it("preserves button identity, focus and forwarded refs as help changes", () => {
  const ref = React.createRef<HTMLButtonElement>();
  const clicked = vi.fn();
  const view = render(
    <Button ref={ref} title="Help" onClick={clicked}>
      Save
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Save" });
  act(() => button.focus());
  expect(screen.getByRole("tooltip").textContent).toBe("Help");
  view.rerender(
    <Button ref={ref} onClick={clicked}>
      Save
    </Button>,
  );
  expect(screen.getByRole("button", { name: "Save" })).toBe(button);
  expect(ref.current).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(button);
  expect(clicked).toHaveBeenCalledOnce();
});

it("uses one description when an icon already has a contextual tooltip", () => {
  render(
    <ControlTooltip content="Contextual help">
      <IconButton label="Settings" />
    </ControlTooltip>,
  );
  const button = screen.getByRole("button", { name: "Settings" });
  fireEvent.pointerEnter(button);
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  expect(button.hasAttribute("title")).toBe(false);
});

it("dismisses portal help on Escape while keeping the icon handler", () => {
  const keyDown = vi.fn();
  render(<IconButton label="Settings" onKeyDown={keyDown} />);
  const button = screen.getByRole("button", { name: "Settings" });
  fireEvent.focus(button);
  expect(screen.getByRole("tooltip").textContent).toBe("Settings");
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(keyDown).toHaveBeenCalledOnce();
});

it("preserves pointer, focus and ref callbacks while hiding help on interaction", () => {
  const ref = vi.fn();
  const enter = vi.fn();
  const leave = vi.fn();
  const down = vi.fn();
  const blur = vi.fn();
  const focus = vi.fn();
  render(
    <Button
      ref={ref}
      title="Help"
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDown={down}
      onBlur={blur}
      onFocus={focus}
    >
      Save
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Save" });
  expect(ref).toHaveBeenCalledWith(button);
  fireEvent.pointerEnter(button);
  expect(screen.getByRole("tooltip").textContent).toBe("Help");
  fireEvent.pointerLeave(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  fireEvent.pointerDown(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  fireEvent.blur(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(enter).toHaveBeenCalledOnce();
  expect(leave).toHaveBeenCalledOnce();
  expect(down).toHaveBeenCalledOnce();
  expect(blur).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledTimes(2);
});
