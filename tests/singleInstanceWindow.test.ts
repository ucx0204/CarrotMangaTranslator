import { describe, expect, it, vi } from "vitest";
import {
  focusExistingMainWindow,
  type FocusableMainWindow,
} from "../src/main/singleInstanceWindow";

describe("single-instance main window focus", () => {
  it("returns false for a missing window", () => {
    expect(focusExistingMainWindow(null)).toBe(false);
  });

  it("returns false without touching a destroyed window", () => {
    const { window, events } = makeWindow({ destroyed: true });

    expect(focusExistingMainWindow(window)).toBe(false);
    expect(events).toEqual([]);
  });

  it("focuses a normal visible window without restoring or showing it", () => {
    const { window, events } = makeWindow();

    expect(focusExistingMainWindow(window)).toBe(true);
    expect(events).toEqual(["focus"]);
  });

  it("restores a minimized window before focusing it", () => {
    const { window, events } = makeWindow({ minimized: true });

    expect(focusExistingMainWindow(window)).toBe(true);
    expect(events).toEqual(["restore", "focus"]);
  });

  it("shows a hidden window before focusing it", () => {
    const { window, events } = makeWindow({ visible: false });

    expect(focusExistingMainWindow(window)).toBe(true);
    expect(events).toEqual(["show", "focus"]);
  });

  it("restores, shows, and focuses a minimized hidden window in order", () => {
    const { window, events } = makeWindow({ minimized: true, visible: false });

    expect(focusExistingMainWindow(window)).toBe(true);
    expect(events).toEqual(["restore", "show", "focus"]);
  });
});

function makeWindow(
  options: {
    destroyed?: boolean;
    minimized?: boolean;
    visible?: boolean;
  } = {},
): { window: FocusableMainWindow; events: string[] } {
  const events: string[] = [];
  const window: FocusableMainWindow = {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isMinimized: vi.fn(() => options.minimized ?? false),
    restore: vi.fn(() => events.push("restore")),
    isVisible: vi.fn(() => options.visible ?? true),
    show: vi.fn(() => events.push("show")),
    focus: vi.fn(() => events.push("focus")),
  };
  return { window, events };
}
