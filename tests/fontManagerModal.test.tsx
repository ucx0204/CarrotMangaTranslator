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
import { DEFAULT_BLOCK_FONT_ID } from "../src/shared/blockFontCatalog";
import type { FontPreferences } from "../src/shared/libraryTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { FontManagerModal } from "../src/renderer/src/components/FontManagerModal";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { FontsProvider } from "../src/renderer/src/fonts/FontsProvider";
import {
  createBlockFontCatalog,
  getBaseBlockFontOptions,
  getBlockFontOptions,
} from "../src/renderer/src/lib/fonts";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  cleanup();
  for (const item of getToasts()) {
    dismissToast(item.id);
  }
  document.getElementById("mgt-custom-fonts")?.remove();
  vi.restoreAllMocks();
});

describe("FontManagerModal", () => {
  it("saves hidden fonts and keeps the default font visible", async () => {
    const saveFontPreferences = vi.fn(async (preferences) => ({
      customFonts: [],
      preferences,
    }));
    Object.defineProperty(window, "mangaApi", {
      configurable: true,
      value: createTestMangaGatewayStub({
        getFontLibrary: async () => ({
          customFonts: [],
          preferences: {
            hiddenIds: [],
            favoriteIds: [],
            orderedIds: [],
            defaultFontId: DEFAULT_BLOCK_FONT_ID,
          },
        }),
        onFontLibraryChanged: () => () => undefined,
        saveFontPreferences,
      }),
    });

    render(
      <FontsProvider>
        <FontManagerModal onClose={vi.fn()} />
      </FontsProvider>,
    );

    const hideButtons = await screen.findAllByRole("button", {
      name: /목록에서 숨기기$/,
    });
    const enabledHide = hideButtons.find(
      (button) => !(button as HTMLButtonElement).disabled,
    );
    expect(enabledHide).toBeTruthy();
    fireEvent.click(enabledHide as HTMLButtonElement);
    expect(screen.getByRole("heading", { name: "숨긴 폰트" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(saveFontPreferences).toHaveBeenCalledOnce());
    const saved = saveFontPreferences.mock.calls[0]?.[0];
    expect(saved?.hiddenIds).toHaveLength(1);
    expect(saved?.hiddenIds).not.toContain(DEFAULT_BLOCK_FONT_ID);
  });

  it("restores hidden fonts and deletes custom fonts from the manager", async () => {
    const customId = "7432f752-8615-4708-a3d6-57bbcb05bdda";
    const removeCustomFont = vi.fn(async () => undefined);
    const preferences: FontPreferences = {
      hiddenIds: [customId],
      favoriteIds: [],
      orderedIds: [],
      defaultFontId: DEFAULT_BLOCK_FONT_ID,
    };
    const catalog = createBlockFontCatalog(
      [
        {
          id: customId,
          label: "My Font",
          family: "MGTUser-MyFont",
          fileName: "my-font.otf",
        },
      ],
      preferences,
    );

    render(
      <FontsContext.Provider
        value={{
          catalog,
          baseOptions: getBaseBlockFontOptions(catalog),
          options: getBlockFontOptions(catalog),
          ready: true,
          busy: false,
          registerFont: () => Promise.resolve(),
          removeFont: removeCustomFont,
          savePreferences: () => Promise.resolve(),
        }}
      >
        <FontManagerModal onClose={vi.fn()} />
      </FontsContext.Provider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "My Font 목록에 다시 표시",
      }),
    );
    expect(
      screen.getByRole("button", { name: "My Font 목록에서 숨기기" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "My Font 삭제" }));
    await waitFor(() =>
      expect(removeCustomFont).toHaveBeenCalledWith(customId),
    );
  });

  it("keeps the modal open and reports a preference save failure", async () => {
    const error = new Error("disk full");
    const saveFontPreferences = vi.fn().mockRejectedValue(error);
    const onClose = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    Object.defineProperty(window, "mangaApi", {
      configurable: true,
      value: createTestMangaGatewayStub({
        getFontLibrary: async () => ({
          customFonts: [],
          preferences: {
            hiddenIds: [],
            favoriteIds: [],
            orderedIds: [],
            defaultFontId: DEFAULT_BLOCK_FONT_ID,
          },
        }),
        onFontLibraryChanged: () => () => undefined,
        saveFontPreferences,
      }),
    });

    render(
      <FontsProvider>
        <FontManagerModal onClose={onClose} />
      </FontsProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(saveFontPreferences).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(getToasts()).toContainEqual(
        expect.objectContaining({
          variant: "error",
          message: "폰트 설정을 저장하지 못했습니다.",
        }),
      ),
    );
    expect(consoleError).toHaveBeenCalledWith(error);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "폰트 관리" })).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "저장" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
