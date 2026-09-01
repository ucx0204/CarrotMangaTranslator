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
import { FontSelect } from "../src/renderer/src/components/FontSelect";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import {
  createBlockFontCatalog,
  getBaseBlockFontOptions,
  getBlockFontOptions,
} from "../src/renderer/src/lib/fonts";
import { DEFAULT_BLOCK_FONT_ID } from "../src/shared/blockFontCatalog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("phase 4 management controls", () => {
  it("orders preset row actions as overwrite, rename, delete and opens both shortcuts", async () => {
    const onManage = vi.fn();
    const onOverwrite = vi.fn(async () => true);
    const onRename = vi.fn(async () => true);
    render(
      <BlockStylePresetControls
        activePresetId=""
        canCreate
        disabled={false}
        presets={[
          {
            id: "style-preset:dialogue",
            name: "대사",
            pinned: true,
            missingFont: false,
          },
        ]}
        onApply={vi.fn()}
        onCreate={vi.fn(async () => true)}
        onDelete={vi.fn(async () => true)}
        onManage={onManage}
        onOverwrite={onOverwrite}
        onRename={onRename}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "프리셋 관리" }));
    expect(onManage).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "프리셋 선택" }));
    const overwrite = screen.getByRole("menuitem", {
      name: "대사 현재 서식으로 덮어쓰기",
    });
    const rename = screen.getByRole("menuitem", { name: "대사 이름 변경" });
    const remove = screen.getByRole("menuitem", { name: "대사 삭제" });
    expect(
      Array.from(overwrite.parentElement?.querySelectorAll("button") ?? []),
    ).toEqual([overwrite, rename, remove]);

    fireEvent.click(overwrite);
    await waitFor(() =>
      expect(onOverwrite).toHaveBeenCalledWith("style-preset:dialogue"),
    );
    fireEvent.click(rename);
    fireEvent.change(screen.getByRole("textbox", { name: "프리셋 이름" }), {
      target: { value: "독백" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("style-preset:dialogue", "독백"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "현재 서식으로 만들기" }),
    );
    expect(
      screen.getByRole("heading", { name: "새 서식 프리셋" }),
    ).toBeTruthy();
  });

  it("keeps registration and deletion out of the picker and preserves a hidden current font", () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const catalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "My Font",
          family: "MGTUser-MyFont",
          fileName: "my-font.otf",
        },
      ],
      {
        favoriteIds: [],
        orderedIds: [],
        hiddenIds: [customId],
        defaultFontId: DEFAULT_BLOCK_FONT_ID,
      },
    );
    const onOpenManager = vi.fn();
    render(
      <FontsContext.Provider
        value={{
          baseOptions: getBaseBlockFontOptions(catalog),
          busy: false,
          catalog,
          options: getBlockFontOptions(catalog),
          registerFont: async () => undefined,
          removeFont: async () => undefined,
          savePreferences: async () => undefined,
        }}
      >
        <FontSelect
          value={customId}
          onChange={vi.fn()}
          onOpenManager={onOpenManager}
        />
      </FontsContext.Provider>,
    );

    expect(
      screen.getByRole("combobox", { name: "폰트" }).textContent,
    ).toContain("My Font");
    fireEvent.click(screen.getByRole("button", { name: "폰트 관리" }));
    expect(onOpenManager).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("combobox", { name: "폰트" }));
    expect(screen.queryByText("+ TTF/OTF 폰트 등록")).toBeNull();
    expect(screen.queryByRole("button", { name: "My Font 삭제" })).toBeNull();
    expect(screen.getByRole("option", { name: /My Font/ })).toBeTruthy();
  });
});
