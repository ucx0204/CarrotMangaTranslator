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

  it("shows the unified primary keys and their built-in aliases", () => {
    render(<ShortcutsSettingsPanel overrides={{}} onChange={vi.fn()} />);

    expect(screen.queryByLabelText("단축키 프로필")).toBeNull();
    const selectTool = screen.getByRole("button", {
      name: "선택 도구 단축키 변경",
    });
    expect(within(selectTool).getByText("S")).not.toBeNull();
    expect(within(selectTool).getByText("1")).not.toBeNull();

    const chrome = screen.getByRole("button", {
      name: "배경/테두리 표시 전환 단축키 변경",
    });
    expect(within(chrome).getByText("Shift")).not.toBeNull();
    expect(within(chrome).getByText("B")).not.toBeNull();
  });

  it("rejects a conflict without clearing or moving the existing shortcut", () => {
    const onChange = vi.fn();
    render(<ShortcutsSettingsPanel overrides={{}} onChange={onChange} />);
    const blockToggle = screen.getByRole("button", {
      name: "블록 표시 전환 단축키 변경",
    });

    fireEvent.click(blockToggle);
    fireEvent.keyDown(window, { key: "ㅠ", code: "KeyB" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "이미 ‘페인트 브러시’에 사용 중",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "기존 단축키는 변경하지 않았습니다",
    );
    expect(within(blockToggle).getByText("V")).not.toBeNull();
  });
});
