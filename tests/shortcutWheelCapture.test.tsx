/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsSettingsPanel } from "../src/renderer/src/components/settingsModal/ShortcutsSettingsPanel";

afterEach(() => cleanup());

describe("shortcut wheel capture", () => {
  it("captures modified wheel gestures for zoom actions", () => {
    const onChange = vi.fn();
    render(<ShortcutsSettingsPanel overrides={{}} onChange={onChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: "이미지 확대 단축키 변경" }),
    );
    fireEvent.wheel(window, { altKey: true, deltaX: 0, deltaY: -120 });

    expect(onChange).toHaveBeenCalledWith({
      "zoom-in": "alt+wheelup",
    });
  });

  it("does not capture wheel gestures for non-zoom actions", () => {
    const onChange = vi.fn();
    render(<ShortcutsSettingsPanel overrides={{}} onChange={onChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: "블록 표시 전환 단축키 변경" }),
    );
    fireEvent.wheel(window, { deltaX: 0, deltaY: 120 });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders saved wheel gestures as readable shortcut tokens", () => {
    render(
      <ShortcutsSettingsPanel
        overrides={{ "zoom-out": "ctrl+shift+wheeldown" }}
        onChange={vi.fn()}
      />,
    );

    const binding = screen.getByRole("button", {
      name: "이미지 축소 단축키 변경",
    });
    expect(within(binding).getByText("Ctrl")).not.toBeNull();
    expect(within(binding).getByText("Shift")).not.toBeNull();
    expect(within(binding).getByText("Wheel ↓")).not.toBeNull();
  });
});
