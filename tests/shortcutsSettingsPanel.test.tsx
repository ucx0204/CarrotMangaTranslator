/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsSettingsPanel } from "../src/renderer/src/components/settingsModal/ShortcutsSettingsPanel";

afterEach(cleanup);

describe("shortcut settings labels", () => {
  it("uses the canonical renderer catalog for dynamic actions", () => {
    render(<ShortcutsSettingsPanel overrides={{}} onChange={vi.fn()} />);

    expect(screen.getByText("이전 페이지")).not.toBeNull();
    expect(screen.getByText("다음 페이지")).not.toBeNull();
    expect(
      screen.queryByText("settings.shortcuts.actions.page-previous"),
    ).toBeNull();
  });
});
