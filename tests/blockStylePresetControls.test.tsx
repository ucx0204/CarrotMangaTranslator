/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockStylePresetControls } from "../src/renderer/src/components/BlockStylePresetControls";

afterEach(cleanup);

describe("block style preset controls", () => {
  it("uses one clear menu and keeps the applied preset name visible", () => {
    const onApply = vi.fn();
    render(<ControlsHarness onApply={onApply} />);

    const trigger = screen.getByRole("button", { name: "프리셋 선택" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("전체 프리셋")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "서식 프리셋" })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /효과음/ }));

    expect(onApply).toHaveBeenCalledWith("sfx");
    expect(trigger.textContent).toContain("효과음");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps creation inside the same menu when there are no presets", () => {
    render(
      <BlockStylePresetControls
        activePresetId=""
        canCreate
        disabled={false}
        presets={[]}
        onApply={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "프리셋 선택" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "현재 서식으로 만들기" }),
    );
    expect(
      screen.getByRole("dialog", { name: "새 서식 프리셋" }),
    ).not.toBeNull();
  });

  it("opens from the keyboard and omits unavailable menu actions", () => {
    render(
      <BlockStylePresetControls
        activePresetId="dialogue"
        canCreate={false}
        canDelete={false}
        disabled={false}
        presets={[
          {
            id: "dialogue",
            name: "기본 대사",
            pinned: true,
            missingFont: false,
          },
        ]}
        onApply={vi.fn()}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "기본 대사" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen
        .getByRole("menuitemradio", { name: "기본 대사" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.queryByRole("menuitem", { name: "기본 대사 삭제" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "현재 서식으로 만들기" }),
    ).toBeNull();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("deletes a preset directly from the same menu", async () => {
    const onDelete = vi.fn(async () => true);
    render(<ControlsHarness onApply={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "프리셋 선택" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "기본 대사 삭제" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("dialogue"));
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitemradio", { name: "기본 대사" }),
      ).toBeNull(),
    );
    const remainingPreset = screen.getByRole("menuitemradio", {
      name: /효과음/,
    });
    await waitFor(() => expect(document.activeElement).toBe(remainingPreset));
  });
});

function ControlsHarness({
  onApply,
  onDelete = async () => true,
}: {
  onApply: (presetId: string) => void;
  onDelete?: (presetId: string) => boolean | Promise<boolean>;
}): React.JSX.Element {
  const [activePresetId, setActivePresetId] = React.useState("");
  const [presets, setPresets] = React.useState([
    {
      id: "dialogue",
      name: "기본 대사",
      pinned: true,
      missingFont: false,
    },
    {
      id: "sfx",
      name: "효과음",
      pinned: true,
      missingFont: true,
    },
  ]);
  return (
    <BlockStylePresetControls
      activePresetId={activePresetId}
      canCreate
      disabled={false}
      presets={presets}
      onApply={(presetId) => {
        setActivePresetId(presetId);
        onApply(presetId);
      }}
      onCreate={vi.fn()}
      onDelete={async (presetId) => {
        const deleted = await onDelete(presetId);
        if (deleted) {
          setPresets((current) =>
            current.filter((preset) => preset.id !== presetId),
          );
          setActivePresetId((current) => (current === presetId ? "" : current));
        }
        return deleted;
      }}
    />
  );
}
