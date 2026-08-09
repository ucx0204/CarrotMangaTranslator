/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MenuSurface } from "../src/renderer/src/components/ui/MenuSurface";
import { usePopupController } from "../src/renderer/src/components/ui/usePopupController";

afterEach(cleanup);

describe("popup primitives", () => {
  it("shares initial focus and menu navigation", async () => {
    render(<PopupHarness />);
    fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));

    const first = screen.getByRole("menuitem", { name: "첫째" });
    const last = screen.getByRole("menuitem", { name: "셋째" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
  });

  it("closes naturally on Tab and closes with trigger focus on Escape", async () => {
    render(<PopupHarness />);
    const trigger = screen.getByRole("button", { name: "메뉴 열기" });
    fireEvent.click(trigger);
    const first = await screen.findByRole("menuitem", { name: "첫째" });
    fireEvent.keyDown(first, { key: "Tab" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("dismisses on an outside pointer without stealing focus", () => {
    render(<PopupHarness />);
    fireEvent.click(screen.getByRole("button", { name: "메뉴 열기" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

function PopupHarness(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const popup = usePopupController({
    initialFocus: '[role="menuitem"]:not(:disabled)',
    open,
    onOpenChange: setOpen,
  });
  return (
    <div ref={popup.rootRef}>
      <button ref={popup.triggerRef} type="button" onClick={popup.toggle}>
        메뉴 열기
      </button>
      {open ? (
        <MenuSurface
          ref={popup.contentRef}
          ariaLabel="테스트 메뉴"
          onClose={popup.close}
        >
          <button type="button" role="menuitem">
            첫째
          </button>
          <button type="button" role="menuitem" disabled>
            둘째
          </button>
          <button type="button" role="menuitem">
            셋째
          </button>
        </MenuSurface>
      ) : null}
    </div>
  );
}
