/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useShortcutDispatcher,
  type ShortcutHandlers,
} from "../src/renderer/src/hooks/useShortcutDispatcher";
import type { KeybindingOverrides } from "../src/shared/shortcutSettings";

afterEach(cleanup);

describe("customizable page and block shortcut dispatch", () => {
  it("delivers Ctrl+Tab from a translation textarea and prevents native focus movement", () => {
    const blockNext = vi.fn();
    render(<ShortcutHarness handlers={{ "block-next": blockNext }} />);
    const textarea = screen.getByRole("textbox", { name: "번역" });
    textarea.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);

    expect(blockNext).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("allows both block directions in editable fields but blocks page navigation", () => {
    const blockPrevious = vi.fn();
    const pagePrevious = vi.fn();
    render(
      <ShortcutHarness
        handlers={{
          "block-previous": blockPrevious,
          "page-previous": pagePrevious,
        }}
      />,
    );
    const textarea = screen.getByRole("textbox", { name: "번역" });

    fireEvent.keyDown(textarea, { key: "Tab", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(textarea, { key: "PageUp" });
    expect(blockPrevious).toHaveBeenCalledOnce();
    expect(pagePrevious).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "PageUp" });
    expect(pagePrevious).toHaveBeenCalledOnce();
  });

  it("uses a custom page binding without retaining its built-in aliases", () => {
    const pageNext = vi.fn();
    render(
      <ShortcutHarness
        handlers={{ "page-next": pageNext }}
        overrides={{ "page-next": "n" }}
      />,
    );

    fireEvent.keyDown(window, { key: "PageDown" });
    fireEvent.keyDown(window, { key: "d" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(pageNext).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "n" });
    expect(pageNext).toHaveBeenCalledOnce();
  });
});

function ShortcutHarness({
  handlers,
  overrides = {},
}: {
  handlers: ShortcutHandlers;
  overrides?: KeybindingOverrides;
}): React.JSX.Element {
  useShortcutDispatcher({
    context: {
      blockingModalOpen: false,
      paletteOpen: false,
      helpOpen: false,
      chapterOpen: true,
      jobActive: false,
      retouchToolActive: false,
      blockSelected: true,
    },
    handlers,
    overrides,
  });
  return <textarea aria-label="번역" />;
}
