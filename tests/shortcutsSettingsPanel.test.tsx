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
    expect(screen.getByText("사각 지우개")).not.toBeNull();
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
